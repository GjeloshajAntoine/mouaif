// Build an editable JSON value from an MCP tool's JSON Schema. Defaults,
// consts, examples, and enums win; otherwise each declared property gets a
// neutral value matching its type so the action editor shows the full shape.
export function schemaExample(schema, depth = 0) {
if (!schema || typeof schema !== 'object' || depth > 12) return null;
if (Object.prototype.hasOwnProperty.call(schema, 'default')) return schema.default;
if (Object.prototype.hasOwnProperty.call(schema, 'const')) return schema.const;
if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
const variant = (Array.isArray(schema.oneOf) && schema.oneOf[0])
|| (Array.isArray(schema.anyOf) && schema.anyOf[0]);
if (variant) return schemaExample(variant, depth + 1);
const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== 'null') : schema.type;
if (type === 'object' || schema.properties) {
const out = {};
for (const [key, property] of Object.entries(schema.properties || {})) {
out[key] = schemaExample(property, depth + 1);
}
return out;
}
if (type === 'array') return [];
if (type === 'boolean') return false;
if (type === 'integer' || type === 'number') return 0;
if (type === 'null') return null;
return '';
}
export function schemaJson(schema) {
return JSON.stringify(schemaExample(schema) || {}, null, 2);
}
