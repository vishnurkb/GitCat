// Param specs are tiny strings so the catalog stays readable and the prompt stays short:
//   "str!"  required string      "str"  optional string
//   "int"   integer              "bool" boolean
//   "list"  array of strings (a single string is accepted and wrapped)
//   "a|b|c" enum (first value is NOT a default — omitted means omitted)

export function parseSpec(spec) {
  const required = spec.endsWith("!");
  const base = required ? spec.slice(0, -1) : spec;
  if (["str", "int", "bool", "list"].includes(base)) return { type: base, required };
  return { type: "enum", values: base.split("|"), required };
}

function coerce(value, spec) {
  if (value === undefined || value === null || value === "") return undefined;
  switch (spec.type) {
    case "str":
      return Array.isArray(value) ? value.join(" ") : String(value).trim() || undefined;
    case "int": {
      const n = parseInt(value, 10);
      return Number.isFinite(n) ? n : undefined;
    }
    case "bool":
      if (typeof value === "boolean") return value;
      return ["true", "yes", "1", "y"].includes(String(value).toLowerCase());
    case "list": {
      const arr = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
      const clean = arr.map((v) => String(v).trim()).filter(Boolean);
      return clean.length ? clean : undefined;
    }
    case "enum": {
      const v = String(value).toLowerCase().trim();
      return spec.values.includes(v) ? v : undefined;
    }
  }
  return value;
}

/** Coerce model-supplied args against an op's params. Returns {args, missing[]}. */
export function normalizeArgs(op, raw = {}) {
  const args = {};
  const missing = [];
  for (const [name, specStr] of Object.entries(op.params || {})) {
    const spec = parseSpec(specStr);
    const v = coerce(raw[name], spec);
    if (v === undefined) {
      if (spec.required) missing.push(name);
    } else args[name] = v;
  }
  return { args, missing };
}

/** "name!, all?" style signature for the prompt. */
export function signature(op) {
  const parts = Object.entries(op.params || {}).map(([n, s]) => {
    const spec = parseSpec(s);
    const t = spec.type === "enum" ? spec.values.join("|") : spec.type;
    return spec.required ? `${n}:${t}` : `${n}?:${t}`;
  });
  return parts.join(", ");
}
