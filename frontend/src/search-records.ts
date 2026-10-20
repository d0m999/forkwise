import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { SearchStateCommand } from "../../backend/src/mapping/search-state";
import type {
  SearchConditions,
  SearchStateView,
} from "../../backend/src/mapping/search-contracts";

type Operation = {
  [T in SearchStateCommand["type"]]: Omit<
    Extract<SearchStateCommand, { type: T }>,
    "commandId" | "projectId" | "expected"
  >;
}[SearchStateCommand["type"]];
type Pending = {
  id: string;
  operation: Operation;
  command?: SearchStateCommand;
};
type Ref<T> = { current: T };
type Session = {
  current: Ref<SearchStateView | undefined>;
  queue: Ref<Pending[]>;
  saving: Ref<boolean>;
  failed: Ref<boolean>;
  failureCode: Ref<string>;
  run: Ref<number>;
  reconcile: Ref<boolean>;
  state: SearchStateView | undefined;
  error: string;
  loading: boolean;
  listeners: Set<() => void>;
};
// Only unconfirmed work survives a project switch in this app session. SQLite
// remains the authority; a normal clean remount reads it again.
const sessions = new Map<string, Session>();
function searchSession(projectId: string): Session {
  let session = sessions.get(projectId);
  if (!session) {
    session = {
      current: { current: undefined },
      queue: { current: [] },
      saving: { current: false },
      failed: { current: false },
      failureCode: { current: "" },
      run: { current: 0 },
      reconcile: { current: false },
      state: undefined,
      error: "",
      loading: false,
      listeners: new Set(),
    };
    sessions.set(projectId, session);
  }
  return session;
}

// Search preferences have their own version and request queue. They never use
// the canvas action router or acknowledge a newer input with an older response.
export function useSearchRecords(
  projectId: string,
  onLoad: (query: SearchConditions) => void,
) {
  const [session] = useState(() => searchSession(projectId));
  const [state, setState] = useState(session.state);
  const [error, setError] = useState(session.error);
  const loaded = useRef(onLoad);
  loaded.current = onLoad;
  const { current, queue, saving, failed, failureCode, run } = session;
  const notify = () => {
    for (const listener of session.listeners) listener();
  };
  const reportError = (message: string) => {
    session.error = message;
    notify();
  };
  const releaseCleanSession = () => {
    if (
      !session.listeners.size &&
      !session.loading &&
      !saving.current &&
      !queue.current.length &&
      !session.error &&
      sessions.get(projectId) === session
    )
      sessions.delete(projectId);
  };
  const preview = (value: SearchStateView) => {
    const displayed = structuredClone(value);
    for (const pending of queue.current) {
      const operation = pending.operation;
      if ("query" in operation.payload)
        displayed.current = operation.payload.query;
      if (
        operation.type === "search.clear" ||
        operation.type === "search.delete"
      ) {
        const entries = displayed.history.filter(
          (h) =>
            operation.type === "search.clear" || h.id === operation.payload.id,
        );
        displayed.removed = { id: pending.id, entries };
        displayed.history = displayed.history.filter(
          (h) => !entries.some((entry) => entry.id === h.id),
        );
      }
    }
    return displayed;
  };
  const publish = (value: SearchStateView) => {
    current.current = value;
    session.state = preview(value);
    notify();
  };
  const flush = async (keepalive = false) => {
    if (saving.current || failed.current || !current.current) return;
    saving.current = true;
    const token = run.current;
    try {
      while (queue.current.length) {
        const pending = queue.current[0]!;
        pending.command ??= {
          ...pending.operation,
          projectId,
          expected: current.current.versionId,
          commandId: pending.id,
        };
        let receipt;
        try {
          receipt = await api.execute(pending.command, { keepalive });
        } catch (failure) {
          if (
            !session.reconcile.current ||
            (failure as { code?: string }).code !== "VERSION_CONFLICT"
          )
            throw failure;
          const latest = await api.searchState(projectId);
          if (token !== run.current) return;
          // Only an explicit rejection proves this key was not consumed. An
          // unknown ACK always replays its original body before any rebase.
          pending.command = { ...pending.command, expected: latest.versionId };
          receipt = await api.execute(pending.command);
        }
        if (token !== run.current) return;
        if (!receipt.searchState) throw new Error("搜索记录保存结果不完整");
        const value = session.reconcile.current
          ? await api.searchState(projectId)
          : receipt.searchState;
        if (token !== run.current) return;
        queue.current.shift();
        publish(value);
      }
      session.reconcile.current = false;
      reportError("");
    } catch (failure) {
      if (token !== run.current) return;
      failed.current = true;
      failureCode.current = (failure as { code?: string }).code ?? "";
      reportError("未能保存搜索记录 · 重试");
    } finally {
      if (token === run.current) saving.current = false;
      releaseCleanSession();
    }
  };
  const write = (operation: Operation) => {
    const last = queue.current.at(-1);
    // Only an unsent preference can be replaced. Sent requests retain their
    // original identity and body for an unknown-outcome retry.
    if (
      operation.type === "search.save" &&
      last?.operation.type === "search.save" &&
      !last.command
    )
      last.operation = operation;
    else
      queue.current.push({
        id: crypto.randomUUID(),
        operation: structuredClone(operation),
      });
    const id = queue.current.at(-1)!.id;
    if (current.current) {
      session.state = preview(current.current);
      notify();
    }
    void flush();
    return id;
  };
  const finish = (query: SearchConditions) => {
    if (!current.current) return;
    // One request survives normal page navigation. It carries the exact sent
    // requests so an unknown ACK can be resolved by the original receipt.
    const pending = queue.current.map(
      (value) =>
        value.command ?? { ...value.operation, projectId, commandId: value.id },
    );
    const operation: Operation = {
      type: "search.record",
      payload: { query, intent: "exit", pending },
    };
    const id = crypto.randomUUID();
    queue.current = [
      {
        id,
        operation,
        command: {
          ...operation,
          projectId,
          commandId: id,
          expected: current.current.versionId,
        },
      },
    ];
    run.current++;
    session.reconcile.current = false;
    saving.current = false;
    failed.current = false;
    void flush(true);
  };
  useEffect(() => {
    let initialized = false;
    const display = () => {
      setState(session.state);
      setError(session.error);
      if (!initialized && session.state) {
        initialized = true;
        loaded.current(session.state.current);
      }
    };
    session.listeners.add(display);
    display();
    if (!current.current && !session.loading && !failed.current) {
      session.loading = true;
      void api
        .searchState(projectId)
        .then((value) => {
          publish(value);
          void flush();
        })
        .catch(() => {
          failed.current = true;
          reportError("未能保存搜索记录 · 重试");
        })
        .finally(() => {
          session.loading = false;
          releaseCleanSession();
        });
    }
    return () => {
      session.listeners.delete(display);
      releaseCleanSession();
    };
  }, [projectId]);
  const retry = async () => {
    try {
      if (!current.current || failureCode.current === "VERSION_CONFLICT") {
        const first = queue.current[0];
        if (
          failureCode.current === "VERSION_CONFLICT" &&
          first?.operation.type === "search.record" &&
          first.operation.payload.pending
        ) {
          // This outer request is known to have failed atomically. Recover its
          // original operations, including cleanup intent, for an explicit
          // retry. A saved child is replayed unchanged, then its latest public
          // state is read before the next CAS; its old receipt is not a new lock.
          const children = first.operation.payload.pending.map((value) => {
            const command = value as SearchStateCommand;
            return {
              id: command.commandId,
              operation: {
                type: command.type,
                payload: command.payload,
              } as Operation,
              ...("expected" in value ? { command } : {}),
            };
          });
          const { pending: _, ...payload } = first.operation.payload;
          queue.current = [
            ...children,
            { id: first.id, operation: { type: "search.record", payload } },
            ...queue.current.slice(1),
          ];
          session.reconcile.current = true;
        }
        const value = await api.searchState(projectId);
        if (
          failureCode.current === "VERSION_CONFLICT" &&
          queue.current[0] &&
          !session.reconcile.current
        )
          delete queue.current[0].command;
        publish(value);
      }
      failureCode.current = "";
      failed.current = false;
      await flush();
    } catch {
      reportError("未能保存搜索记录 · 重试");
    }
  };
  return {
    state,
    error,
    write,
    finish,
    retry: () => {
      void retry();
    },
  };
}
