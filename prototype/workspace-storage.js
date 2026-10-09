/* 原型本机保存。数据库按浏览器 origin 隔离；这不是正式版 SQLite 备份。 */
(function (root) {
  'use strict';

  const DATABASE = 'forkwise-step-prototype-workspace';
  const STORE = 'snapshots';
  const SCHEMA_VERSION = 1;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  function failure(code, message, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }

  function validateWorkspace(payload, validatePayload) {
    if (!plain(payload)) throw failure('INVALID_PAYLOAD', '研究工作区必须是 JSON 对象。');
    const entries = own(payload, 'projects') ? payload.projects : payload.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      throw failure('INVALID_PAYLOAD', '研究工作区缺少项目列表。');
    }
    const ids = new Set();
    for (const entry of entries) {
      const id = Array.isArray(entry) ? entry[0] : entry?.id;
      const project = Array.isArray(entry) ? entry[1] : entry;
      if (typeof id !== 'string' || !id.trim() || ids.has(id) || !plain(project) || !plain(project.study)) {
        throw failure('INVALID_PAYLOAD', '项目标识、研究内容或项目列表结构无效。');
      }
      if (Array.isArray(entry) && entry.length !== 2) throw failure('INVALID_PAYLOAD', '项目列表条目无效。');
      ids.add(id);
    }
    for (const key of ['projectId', 'activeProjectId']) {
      if (own(payload, key) && !ids.has(payload[key])) throw failure('INVALID_PAYLOAD', '当前研究项目不在保存的项目列表中。');
    }
    if (validatePayload) {
      const result = validatePayload(payload);
      if (result === false || result?.then) throw failure('INVALID_PAYLOAD', '研究内容校验失败；校验函数必须同步完成。');
    }
  }

  function serialize(payload, validatePayload) {
    let json;
    try {
      json = JSON.stringify(payload, (key, value) => {
        if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' ||
            (typeof value === 'number' && !Number.isFinite(value)) || value instanceof Map || value instanceof Set) {
          throw failure('INVALID_PAYLOAD', '研究工作区含有无法完整保存的非 JSON 数据。');
        }
        return value;
      });
      const copy = JSON.parse(json);
      validateWorkspace(copy, validatePayload);
    } catch (error) {
      if (error.code === 'INVALID_PAYLOAD') throw error;
      throw failure('INVALID_PAYLOAD', '研究内容校验失败，尚未写入本机存储。', error);
    }
    return json;
  }

  // 仅检测快照字节的意外损坏，不用于安全认证。
  function checksum(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function decode(record, validatePayload) {
    if (!plain(record)) throw failure('CORRUPT_SNAPSHOT', '保存的研究快照缺失或损坏。');
    if (!own(record, 'schemaVersion')) throw failure('CORRUPT_SNAPSHOT', '保存的研究快照缺少格式信息。');
    if (record.schemaVersion !== SCHEMA_VERSION) {
      throw failure('UNSUPPORTED_SCHEMA', '保存数据的格式版本不受当前原型支持，已停止写入。');
    }
    if (!Number.isSafeInteger(record.revision) || record.revision < 1 ||
        typeof record.savedAt !== 'string' || !Number.isFinite(Date.parse(record.savedAt)) ||
        typeof record.payloadJSON !== 'string' || record.checksum !== checksum(record.payloadJSON)) {
      throw failure('CORRUPT_SNAPSHOT', '保存的研究快照校验失败。');
    }
    let payload;
    try {
      payload = JSON.parse(record.payloadJSON);
      validateWorkspace(payload, validatePayload);
    } catch (error) {
      throw failure('CORRUPT_SNAPSHOT', '保存的研究内容校验失败。', error);
    }
    return { revision: record.revision, savedAt: record.savedAt, payload };
  }

  function selectSnapshot(records, validatePayload) {
    const { current, previous, revision } = records;
    if (current === undefined && previous === undefined && revision === undefined) return null;
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw failure('CORRUPT_STORAGE', '本机保存的版本记录损坏，已停止写入以保留现场。');
    }
    try {
      const result = decode(current, validatePayload);
      if (result.revision !== revision) throw failure('CORRUPT_SNAPSHOT', '研究快照与保存版本不一致。');
      return { ...result, recoveredFromBackup: false };
    } catch (currentError) {
      if (currentError.code === 'UNSUPPORTED_SCHEMA') throw currentError;
      try {
        const result = decode(previous, validatePayload);
        if (result.revision >= revision) throw failure('CORRUPT_SNAPSHOT', '上一份研究副本的版本无效。');
        return { ...result, revision, snapshotRevision: result.revision, recoveredFromBackup: true };
      } catch (backupError) {
        if (backupError.code === 'UNSUPPORTED_SCHEMA') throw backupError;
        throw failure('CORRUPT_STORAGE', '当前研究快照及上一份副本均无法读取，已停止写入以保留现场。', currentError);
      }
    }
  }

  function open(options = {}) {
    let database = null, connecting = null, queue = Promise.resolve();
    let loaded = false, lastRevision = 0, closed = false, blockedError = null;
    const validatePayload = options.validatePayload;
    const emit = (state, extra = {}) => {
      try { options.onStatus?.({ state, ...extra }); } catch (_) { /* 界面回调不改变保存结果。 */ }
    };
    const fail = error => { emit('error', { error }); throw error; };
    const enqueue = operation => {
      const promise = queue.then(operation);
      queue = promise.catch(() => {});
      return promise.catch(fail);
    };

    function connect() {
      if (closed) return Promise.reject(failure('CLOSED', '本机保存已关闭。'));
      if (database) return Promise.resolve(database);
      if (connecting) return connecting;
      emit('opening');
      connecting = new Promise((resolve, reject) => {
        let request, settled = false;
        const rejectOpen = error => { if (!settled) { settled = true; reject(error); } };
        try {
          if (!root.indexedDB) throw failure('UNAVAILABLE', '当前浏览器无法使用本机保存。');
          request = root.indexedDB.open(DATABASE, 1);
        } catch (error) {
          rejectOpen(error.code ? error : failure('UNAVAILABLE', '无法打开本机保存。', error));
          return;
        }
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
        };
        request.onerror = () => rejectOpen(failure('UNAVAILABLE', '无法打开本机保存。', request.error));
        request.onblocked = () => rejectOpen(failure('BLOCKED', '本机存储升级被其它页面阻止，请关闭旧页面后重试。'));
        request.onsuccess = () => {
          if (settled || closed) {
            request.result.close();
            rejectOpen(failure('CLOSED', '本机保存已关闭。'));
            return;
          }
          settled = true;
          database = request.result;
          database.onversionchange = () => {
            database.close();
            database = null;
            blockedError = failure('VERSION_CHANGED', '另一页面更新了本机存储，请重新打开页面后继续保存。');
            emit('error', { error: blockedError });
          };
          resolve(database);
        };
      }).finally(() => { connecting = null; });
      return connecting;
    }

    function transact(db, mode, apply) {
      return new Promise((resolve, reject) => {
        let transaction, result, operationError;
        try { transaction = db.transaction(STORE, mode); }
        catch (error) { reject(failure('UNAVAILABLE', '本机保存事务无法启动。', error)); return; }
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(operationError || failure(mode === 'readwrite' ? 'WRITE_FAILED' : 'READ_FAILED',
          mode === 'readwrite' ? '本机保存未完成，当前修改仍未保存。' : '无法读取本机研究，已停止写入以保留现场。', transaction.error));
        transaction.onerror = () => {}; // onabort 统一报告；事务成功前不报告“已保存”。
        const store = transaction.objectStore(STORE), records = {};
        let remaining = 3;
        for (const key of ['current', 'previous', 'revision']) {
          const request = store.get(key);
          request.onsuccess = () => {
            records[key] = request.result;
            if (--remaining) return;
            try { result = apply(records, store); }
            catch (error) {
              operationError = typeof error.code === 'string' ? error : failure(mode === 'readwrite' ? 'WRITE_FAILED' : 'READ_FAILED',
                mode === 'readwrite' ? '本机保存未完成，当前修改仍未保存。' : '无法读取本机研究，已停止写入以保留现场。', error);
              transaction.abort();
            }
          };
        }
      });
    }

    return {
      load() {
        return enqueue(async () => {
          emit('loading');
          try {
            const db = await connect();
            const result = await transact(db, 'readonly', records => selectSnapshot(records, validatePayload));
            loaded = true;
            blockedError = null;
            lastRevision = result?.revision || 0;
            emit(!result ? 'empty' : result.recoveredFromBackup ? 'recovered' : 'loaded', result || {});
            return result;
          } catch (error) { loaded = false; blockedError = error; throw error; }
        });
      },
      save(payload, saveOptions = {}) {
        let payloadJSON;
        try { payloadJSON = serialize(payload, validatePayload); }
        catch (error) { emit('error', { error }); return Promise.reject(error); }
        return enqueue(async () => {
          if (blockedError) throw blockedError;
          if (!loaded) throw failure('LOAD_REQUIRED', '请先读取本机研究，再保存修改。');
          const expectedRevision = saveOptions.expectedRevision ?? lastRevision;
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw failure('INVALID_REVISION', '保存版本无效。');
          emit('saving');
          const db = await connect();
          const result = await transact(db, 'readwrite', (records, store) => {
            const existing = selectSnapshot(records, validatePayload);
            const actualRevision = existing?.revision || 0;
            if (actualRevision !== expectedRevision) {
              throw failure('CONFLICT', '另一页面已经保存了更新内容。当前修改尚未保存，请先导出当前研究，再重新载入本机版本。');
            }
            if (actualRevision >= Number.MAX_SAFE_INTEGER) throw failure('INVALID_REVISION', '本机保存版本已超出可用范围。');
            const record = { schemaVersion: SCHEMA_VERSION, revision: actualRevision + 1,
              savedAt: new Date().toISOString(), payloadJSON, checksum: checksum(payloadJSON) };
            if (existing && !existing.recoveredFromBackup) store.put(records.current, 'previous');
            store.put(record, 'current');
            store.put(record.revision, 'revision');
            return { revision: record.revision, savedAt: record.savedAt };
          });
          lastRevision = result.revision;
          emit('saved', result);
          return result;
        });
      },
      close() {
        closed = true;
        database?.close();
        database = null;
        emit('closed');
      }
    };
  }

  root.ForkwiseWorkspaceStorage = Object.freeze({ open });
})(window);
