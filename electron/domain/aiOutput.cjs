// The answer format an AI prompt step asks for: the instruction text built from the owner's field list, and the check that a model's answer has every field with the right type. Pure. It never fills a missing field.

const TYPES = ["text", "number", "boolean", "choice"];
// Field names become {{ai.name}} placeholders and condition paths, which split on dots and match \w.
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const choicesOf = (field) => String(field.choices || "").split(",").map((c) => c.trim()).filter(Boolean);

function describeType(field) {
  if (field.type === "number") return "a number";
  if (field.type === "boolean") return "true or false";
  if (field.type === "choice") return `one of ${choicesOf(field).map((c) => JSON.stringify(c)).join(", ")}`;
  return "a non-empty string";
}

function outputInstruction(fields) {
  const lines = fields.map((f) => `- "${f.name}": ${describeType(f)}${f.description ? `. ${f.description}` : ""}`);
  return `Reply with only a JSON object with exactly these keys:\n${lines.join("\n")}\nEvery key is required. Judge only from the data given.`;
}

// Returns the checked value for one field, or undefined when the answer cannot be read as that type.
function readField(field, raw) {
  if (field.type === "number") {
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
    if (typeof raw !== "string" || !raw.trim()) return undefined;
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  if (field.type === "boolean") return typeof raw === "boolean" ? raw : undefined;
  if (field.type === "choice") return typeof raw === "string" ? choicesOf(field).find((c) => c.toLowerCase() === raw.trim().toLowerCase()) : undefined;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function readAnswer(answer, fields) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return { ok: false, error: "the answer is not a JSON object" };
  const value = {};
  for (const field of fields) {
    if (!(field.name in answer)) return { ok: false, error: `"${field.name}" is missing` };
    const read = readField(field, answer[field.name]);
    if (read === undefined) return { ok: false, error: `"${field.name}" should be ${describeType(field)}, got ${JSON.stringify(answer[field.name])?.slice(0, 80)}` };
    value[field.name] = read;
  }
  return { ok: true, value };
}

function fieldProblems(fields) {
  if (!Array.isArray(fields) || !fields.length) return ["Add at least one output field"];
  const problems = [];
  const seen = new Set();
  fields.forEach((f, i) => {
    const name = String(f?.name || "").trim();
    if (!name) { problems.push(`Output field ${i + 1} has no name`); return; }
    if (!NAME.test(name)) problems.push(`Output field "${name}" may use only letters, digits and _`);
    if (seen.has(name)) problems.push(`Output field "${name}" is listed twice`);
    seen.add(name);
    if (!TYPES.includes(f.type)) problems.push(`Output field "${name}" has unknown type "${f.type}"`);
    if (f.type === "choice" && !choicesOf(f).length) problems.push(`Output field "${name}" is a choice but lists no choices`);
  });
  return problems;
}

module.exports = { outputInstruction, readAnswer, fieldProblems, TYPES };
