"""显式范围内的内容清单；不跟随链接、不写输入文件。"""
import fnmatch
from collections import deque
import hashlib
import json
import os
from pathlib import Path
import stat


class Invalid(ValueError):
    pass


def digest(value):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(raw.encode()).hexdigest()


def relative(value):
    if (not isinstance(value, str) or not value or value.startswith(("/", "@"))
            or any(part in {"..", ".", ""} for part in value.split("/"))):
        raise Invalid("路径必须是范围内的相对路径")
    return value


def _parent(path):
    parts = Path(path).absolute().parts
    fd = os.open(parts[0], os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise


def _stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def _read_at(fd, name, info, *, contents=False):
    source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        if not stat.S_ISREG(info.st_mode) or _stamp(os.fstat(source)) != _stamp(info):
            raise Invalid("输入类型或身份在读取前变化")
        chunks, checksum = [], hashlib.sha256()
        while True:
            chunk = os.read(source, 1024 * 1024)
            if not chunk:
                break
            checksum.update(chunk)
            if contents:
                chunks.append(chunk)
        if _stamp(os.fstat(source)) != _stamp(info):
            raise Invalid("输入在读取期间变化")
        return b"".join(chunks) if contents else checksum.hexdigest()
    finally:
        os.close(source)


def read_json(path, *, expected_sha256=None):
    fd, name = _parent(path)
    try:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if info.st_size > 32 * 1024 * 1024:
            raise Invalid("JSON 超出 32 MiB 读取上限")
        raw = _read_at(fd, name, info, contents=True)
    finally:
        os.close(fd)
    if expected_sha256 is not None and hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise Invalid("JSON 内容与原始摘要不符")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise Invalid("JSON 包含重复字段")
            result[key] = value
        return result
    def constant(value):
        raise Invalid("JSON 不允许非有限数值")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


class Inventory:
    def __init__(self):
        self.entries = {}
        self.paths = {}
        self.links = []
        self.directory_members = {}

    def capture(self, path, label, *, optional=False, patterns=None):
        keys, problems = [], []
        try:
            fd, name = _parent(path)
            try:
                self._walk(fd, name, Path(path).absolute(), label, keys, patterns)
            finally:
                os.close(fd)
        except FileNotFoundError:
            self.entries[label] = {"kind": "missing"}
            keys.append(label)
            if not optional:
                problems.append("MISSING_INPUT:" + label)
        except (OSError, Invalid) as exc:
            problems.append("UNREADABLE_INPUT:" + label + ":" + type(exc).__name__)
        return sorted(set(keys)), problems

    def _walk(self, parent, name, path, label, keys, patterns=None):
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        item = {"mode": stat.S_IMODE(info.st_mode)}
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(name, dir_fd=parent)
            item.update(kind="link", target=target)
            self.links.append((label, str(path.parent / target)))
        elif stat.S_ISREG(info.st_mode):
            item.update(kind="file", size=info.st_size, nlink=info.st_nlink,
                        sha256=_read_at(parent, name, info))
        elif stat.S_ISDIR(info.st_mode):
            item.update(kind="directory")
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                if _stamp(os.fstat(fd)) != _stamp(info):
                    raise Invalid("目录身份在读取前变化")
                with os.scandir(fd) as stream:
                    names = sorted(entry.name for entry in stream)
                self.directory_members[str(path)] = [str(path / child) for child in names]
                for child in names:
                    if patterns is None or any(fnmatch.fnmatchcase(child, p) for p in patterns):
                        self._walk(fd, child, path / child, label + "/" + child, keys)
                if _stamp(os.fstat(fd)) != _stamp(info):
                    raise Invalid("目录在读取期间变化")
            finally:
                os.close(fd)
        else:
            raise Invalid("仅支持普通文件、目录及链接")
        if _stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)) != _stamp(info):
            raise Invalid("输入在读取后变化")
        self.entries[label] = item
        self.paths.setdefault(str(path), set()).add(label)
        keys.append(label)

    def external_links(self, keys):
        allowed = set(keys)
        by_label = {label: path for path, labels in self.paths.items() for label in labels}
        targets = {by_label[label]: target for label, target in self.links}
        def fully_covered(path):
            # 目录条目本身不代表其内容已进入本项检查，过滤掉的成员也必须覆盖。
            return (not allowed.isdisjoint(self.paths.get(path, ()))
                    and all(fully_covered(child) for child in self.directory_members.get(path, [])))
        def covered(target):
            # 按 POSIX 顺序展开链接，再处理后续的 ..；不访问链接目标。
            pending, resolved, expansions = deque(Path(target).parts[1:]), Path("/"), 0
            while pending:
                part = pending.popleft()
                if part == "..":
                    resolved = resolved.parent
                    continue
                resolved = resolved / part
                prefix = str(resolved)
                if prefix in targets:
                    expansions += 1
                    if expansions > 40 or allowed.isdisjoint(self.paths[prefix]):
                        return False
                    pending.extendleft(reversed(Path(targets[prefix]).parts[1:]))
                    resolved = Path("/")
            return fully_covered(str(resolved))
        return [label for label, target in self.links if label in allowed and not covered(target)]

    def fingerprint(self, keys):
        return digest({key: self.entries[key] for key in sorted(set(keys))})
