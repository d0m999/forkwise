import { useEffect, useRef, useState } from 'react';
import { api, MappingError, type Command } from './api';
import type { Card, Block } from '../../backend/src/mapping/contracts';
import { imageTask } from '../../backend/src/mapping/media-blocks';
type Result = 'wait' | 'done' | 'unknown';
type Job = {
  projectId: string;
  cardId: string;
  blockId: string;
  ticket: string;
  stage: 'uploading' | 'ready' | 'unknownUpload' | 'unknown' | 'done';
  uncertain?: boolean;
  completion?: Command;
  restart?: () => Promise<void>;
};
const jobKey = (projectId: string, ticket: string) => JSON.stringify([projectId, ticket]);
async function requestKey(job: Job) {
  const bytes = new TextEncoder().encode(
    JSON.stringify([job.projectId, job.cardId, job.blockId, job.ticket]),
  );
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
export function useMediaQueue(
  projectId: string | undefined,
  cards: Card[],
  commit: (command: Command) => Promise<Result>,
) {
  const [, render] = useState(0);
  const jobs = useRef(new Map<string, Job>()),
    latest = useRef({ projectId, cards, commit });
  latest.current = { projectId, cards, commit };
  const draining = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const publish = () => {
      if (mounted.current) render((n) => n + 1);
    };
    async function upload(job: Job, task: Block) {
      job.stage = 'uploading';
      publish();
      try {
        const key = await requestKey(job);
        const command: Command = {
          commandId: 'asset:' + key,
          projectId: job.projectId,
          type: 'asset.save',
          expected: null,
          payload: {
            id: job.ticket,
            name: String(task.name),
            mime: String(task.mime),
            base64: String(task.base64),
          },
        };
        try {
          await api.execute(command);
        } catch (error) {
          // An absent response is not proof that bytes failed to persist. A
          // complete immutable readback may confirm the original upload.
          let confirmed = false;
          try {
            const asset = await api.asset(job.projectId, job.ticket);
            confirmed =
              asset.base64 === task.base64 && asset.name === task.name && asset.mime === task.mime;
          } catch {
            /* Keep an unknown result unknown when no readback is available. */
          }
          if (!confirmed) {
            const rejected =
              error instanceof MappingError &&
              [
                'INVALID_IMAGE',
                'INVALID_SVG',
                'UNSUPPORTED_MEDIA',
                'INVALID_COMMAND',
                'TOO_LARGE',
                'ID_CONFLICT',
              ].includes(error.code);
            if (rejected) {
              job.completion = {
                commandId: 'fail:' + key,
                projectId: job.projectId,
                type: 'media.fail',
                expected: job.ticket,
                payload: {
                  id: job.cardId,
                  blockId: job.blockId,
                  reason: error.message.slice(0, 2000) || '图片保存失败',
                },
              };
              job.stage = 'ready';
              publish();
              return;
            }
            job.stage = 'unknownUpload';
            job.uncertain = true;
            publish();
            return;
          }
        }
        job.completion = {
          commandId: 'finish:' + key,
          projectId: job.projectId,
          type: 'media.finish',
          expected: job.ticket,
          payload: { id: job.cardId, blockId: job.blockId, assetId: job.ticket },
        };
        job.stage = 'ready';
        publish();
      } catch {
        job.stage = 'unknownUpload';
        job.uncertain = true;
        publish();
      }
    }
    async function pump() {
      const current = latest.current;
      if (current.projectId)
        for (const card of current.cards)
          for (const block of card.body.blocks) {
            const task = imageTask(block);
            if (!task || task.status !== 'queued') continue;
            const key = jobKey(current.projectId, String(task.ticket));
            if (jobs.current.has(key)) continue;
            const job: Job = {
              projectId: current.projectId,
              cardId: card.id,
              blockId: block.id,
              ticket: String(task.ticket),
              stage: 'uploading',
            };
            jobs.current.set(key, job);
            job.restart = () => upload(job, task);
            void job.restart();
          }
      if (draining.current || !mounted.current) return;
      const job = [...jobs.current.values()].find((j) => j.stage === 'ready');
      if (!job?.completion) return;
      draining.current = true;
      try {
        const result = await latest.current.commit(job.completion);
        if (result !== 'wait') {
          job.stage = result === 'done' ? 'done' : 'unknown';
          job.uncertain = result === 'unknown';
          publish();
        }
      } catch {
        job.stage = 'unknown';
        job.uncertain = true;
        publish();
      } finally {
        draining.current = false;
      }
    }
    const timer = setInterval(() => {
      void pump();
    }, 200);
    void pump();
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);
  const retry = async (block: Block) => {
    const task = imageTask(block);
    if (!task || !projectId) return;
    const job = jobs.current.get(jobKey(projectId, String(task.ticket)));
    if (job?.stage === 'unknownUpload') {
      void job.restart?.();
      return;
    }
    if (job?.stage === 'unknown') {
      job.stage = 'ready';
      return;
    }
    const owner = cards.find((c) => c.body.blocks.some((b) => b.id === block.id));
    if (!owner) return;
    const command: Command = {
      commandId: crypto.randomUUID(),
      projectId,
      type: 'media.retry',
      expected: String(task.ticket),
      payload: { id: owner.id, blockId: block.id, ticket: crypto.randomUUID() },
    };
    await commit(command);
  };
  return {
    retry,
    hasUnconfirmed: [...jobs.current.values()].some(
      (job) => job.projectId === projectId && job.uncertain && job.stage !== 'done',
    ),
    retryUnconfirmed: () => {
      for (const job of jobs.current.values())
        if (job.projectId === projectId) {
          if (job.stage === 'unknownUpload') void job.restart?.();
          else if (job.stage === 'unknown') job.stage = 'ready';
        }
      render((n) => n + 1);
    },
  };
}
