const escape = (value) =>
  String(value).replaceAll("~", "~0").replaceAll("/", "~1");

// Native JSON.parse checks syntax. This separate position index never reserializes
// numbers or quotes: evidence always refers to the original UTF-16 source.
export function indexJson(raw, fail) {
  if (typeof raw !== "string" || raw.length > 5_000_000)
    fail("JSON 超过当前结构定位边界");
  try {
    JSON.parse(raw);
  } catch {
    fail("材料不是有效 JSON，未降级为无上下文数字片段");
  }
  let pos = 0,
    count = 0;
  const ws = () => {
    while (/\s/.test(raw[pos] ?? "") && pos < raw.length) pos++;
  };
  const string = () => {
    const start = pos++;
    while (raw[pos] !== '"') {
      if (raw[pos] === "\\") pos++;
      pos++;
    }
    pos++;
    return { start, end: pos, value: JSON.parse(raw.slice(start, pos)) };
  };
  function read(path, depth = 0, key) {
    if (depth > 64 || ++count > 500_000)
      fail("JSON 深度或节点数超过结构定位边界");
    ws();
    const node = { start: pos, end: 0, path, key, members: new Map() };
    const first = raw[pos];
    if (first === "{" || first === "[") {
      node.kind = first === "{" ? "object" : "array";
      const closing = first === "{" ? "}" : "]";
      pos++;
      ws();
      while (raw[pos] !== closing) {
        let name, token;
        if (first === "{") {
          token = string();
          name = token.value;
          ws();
          pos++;
          if (node.members.has(name))
            fail("JSON 存在重复键，无法唯一定位原始披露");
        } else name = String(node.members.size);
        node.members.set(
          name,
          read(`${path}/${escape(name)}`, depth + 1, token),
        );
        ws();
        if (raw[pos] === ",") {
          pos++;
          ws();
        } else break;
      }
      pos++;
    } else if (first === '"') {
      node.kind = "string";
      node.value = string().value;
    } else {
      while (pos < raw.length && !/[\s,\]}]/.test(raw[pos])) pos++;
      node.value = JSON.parse(raw.slice(node.start, pos));
      node.kind = node.value === null ? "null" : typeof node.value;
    }
    node.end = pos;
    return node;
  }
  const root = read("");
  return { root };
}
