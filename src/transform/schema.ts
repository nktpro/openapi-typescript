import type { Discriminator, GlobalContext } from "../types.js";
import {
  prepareComment,
  nodeType,
  tsArrayOf,
  tsIntersectionOf,
  tsReadonly,
  tsTupleOf,
  tsUnionOf,
  parseSingleSimpleValue,
  ParsedSimpleValue,
} from "../utils.js";

interface TransformSchemaObjOptions extends GlobalContext {
  required: Set<string>;
}

const EOF_RE = /\n+$/;

function hasDefaultValue(node: any): boolean {
  if ("default" in node) return true;
  // if (node.hasOwnProperty("$ref")) return true; // TODO: resolve remote $refs?
  return false;
}

/** Take object keys and convert to TypeScript interface */
export function transformSchemaObjMap(obj: Record<string, any>, options: TransformSchemaObjOptions): string {
  let output = "";

  for (const k of Object.keys(obj)) {
    const v = obj[k];

    // 1. Add comment in jsdoc notation
    const comment = prepareComment(v);
    if (comment) output += comment;

    // 2. name (with “?” if optional property)
    const readonly = tsReadonly(options.immutableTypes);
    const required =
      options.required.has(k) || (options.defaultNonNullable && hasDefaultValue(v.schema || v)) ? "" : "?";
    output += `${readonly}"${k}"${required}: `;

    // 3. transform
    output += transformSchemaObj(v.schema || v, options);

    // 4. close
    output += `;\n`;
  }

  return output.replace(EOF_RE, "\n"); // replace repeat line endings with only one
}

/** make sure all required fields exist **/
export function addRequiredProps(
  properties: Record<string, any>,
  required: Set<string>,
  additionalProperties: any,
  options: TransformSchemaObjOptions
): string[] {
  const missingRequired = [...required].filter((r: string) => !(r in properties));
  if (missingRequired.length == 0) {
    return [];
  }
  let output = "";

  const valueType = additionalProperties ? transformSchemaObj(additionalProperties, options) : "unknown";

  for (const r of missingRequired) {
    output += `${r}: ${valueType};\n`;
  }
  return [`{\n${output}}`];
}

/** transform anyOf */
export function transformAnyOf(anyOf: any, options: TransformSchemaObjOptions): string {
  // filter out anyOf keys that only have a `required` key. #642
  const schemas = anyOf.filter((s: any) => {
    if (Object.keys(s).length > 1) return true;

    if (s.required) return false;

    return true;
  });

  if (schemas.length === 0) {
    return "";
  }
  return tsUnionOf(schemas.map((s: any) => transformSchemaObj(s, options)));
}

/** transform oneOf */
export function transformOneOf(oneOf: any, options: TransformSchemaObjOptions, discriminator?: Discriminator): string {
  const discriminatorMap = discriminator
    ? new Map(Object.entries(discriminator.mapping).map(([k, v]) => [v, k]))
    : new Map();

  const types = oneOf.map((value: any) => {
    const ref = nodeType(value) === "ref" ? value.$ref : undefined;

    const out = transformSchemaObj(value, options);

    if (discriminator && ref !== undefined && discriminatorMap.has(ref)) {
      return `${out} & { ${discriminator.propertyName}: ${JSON.stringify(discriminatorMap.get(ref))} }`;
    }

    return out;
  });

  return tsUnionOf(types);
}

/** Convert schema object to TypeScript */
export function transformSchemaObj(node: any, options: TransformSchemaObjOptions): string {
  const readonly = tsReadonly(options.immutableTypes);

  let output = "";

  // pass in formatter, if specified
  const overriddenType = options.formatter && options.formatter(node);

  // open nullable
  if (node.nullable) {
    output += "(";
  }

  if (overriddenType) {
    output += overriddenType;
  } else {
    // transform core type
    switch (nodeType(node)) {
      case "type-array":
        // This is an array of types as of the 3.1 specification - we should recursively evaluate them
        output += tsUnionOf((node.type as any[]).map((type) => transformSchemaObj({ ...node, type }, options)));
        break;
      case "ref": {
        output += node.$ref; // these were transformed at load time when remote schemas were resolved; return as-is
        break;
      }
      case "null":
      case "string":
      case "number":
      case "boolean":
      case "unknown": {
        output += nodeType(node);
        break;
      }
      case "const": {
        output += parseSingleSimpleValue(node.const, node.nullable);
        break;
      }
      case "enum": {
        const items: Array<ParsedSimpleValue> = [];
        (node.enum as unknown[]).forEach((item) => {
          const value = parseSingleSimpleValue(item, node.nullable);
          items.push(value);
        });
        output += tsUnionOf(items);
        break;
      }
      case "object": {
        const isAnyOfOrOneOfOrAllOf = "anyOf" in node || "oneOf" in node || "allOf" in node;
        const missingRequired = addRequiredProps(
          node.properties || {},
          node.required || [],
          node.additionalProperties,
          options
        );
        // if empty object, then return generic map type
        if (
          !isAnyOfOrOneOfOrAllOf &&
          (!node.properties || !Object.keys(node.properties).length) &&
          !node.additionalProperties
        ) {
          const emptyObj = `{ ${readonly}[key: string]: unknown }`;

          output += tsIntersectionOf([emptyObj, ...missingRequired]);
          break;
        }

        const properties = transformSchemaObjMap(node.properties || {}, {
          ...options,
          required: new Set(node.required || []),
        });

        // if additional properties, add an intersection with a generic map type
        let additionalProperties: string | undefined;
        if (
          node.additionalProperties ||
          (node.additionalProperties === undefined && options.additionalProperties && options.version === 3)
        ) {
          if ((node.additionalProperties ?? true) === true || Object.keys(node.additionalProperties).length === 0) {
            additionalProperties = `{ ${readonly}[key: string]: unknown }`;
          } else if (typeof node.additionalProperties === "object") {
            const oneOf: any[] | undefined = (node.additionalProperties as any).oneOf || undefined; // TypeScript does a really bad job at inference here, so we enforce a type
            const anyOf: any[] | undefined = (node.additionalProperties as any).anyOf || undefined; // "
            if (oneOf) {
              additionalProperties = `{ ${readonly}[key: string]: ${transformOneOf(oneOf, options)}; }`;
            } else if (anyOf) {
              additionalProperties = `{ ${readonly}[key: string]: ${transformAnyOf(anyOf, options)}; }`;
            } else {
              additionalProperties = `{ ${readonly}[key: string]: ${
                transformSchemaObj(node.additionalProperties, options) || "unknown"
              }; }`;
            }
          }
        }

        output += tsIntersectionOf([
          // append allOf/anyOf/oneOf first
          ...(node.allOf ? (node.allOf as any[]).map((node) => transformSchemaObj(node, options)) : []),
          ...(node.anyOf ? [transformAnyOf(node.anyOf, options)] : []),
          ...(node.oneOf ? [transformOneOf(node.oneOf, options, node.discriminator)] : []),
          ...(properties ? [`{\n${properties}\n}`] : []), // then properties (line breaks are important!)
          ...missingRequired, // add required that are missing from properties
          ...(additionalProperties ? [additionalProperties] : []), // then additional properties
        ]);

        break;
      }

      case "array": {
        if (Array.isArray(node.items)) {
          output += `${readonly}${tsTupleOf(node.items.map((node: any) => transformSchemaObj(node, options)))}`;
        } else {
          const minItems: number = Number.isInteger(node.minItems) && node.minItems >= 0 ? node.minItems : 0;
          const maxItems: number | undefined =
            Number.isInteger(node.maxItems) && node.maxItems >= 0 && minItems <= node.maxItems
              ? node.maxItems
              : undefined;

          const estimateCodeSize =
            maxItems === undefined ? minItems : (maxItems * (maxItems + 1) - minItems * (minItems - 1)) / 2;
          const items = node.items ? transformSchemaObj(node.items as any, options) : "unknown";
          if ((minItems !== 0 || maxItems !== undefined) && options.supportArrayLength && estimateCodeSize < 30) {
            if (maxItems === undefined) {
              output += `${readonly}${tsTupleOf([
                ...Array.from({ length: minItems }).map(() => items),
                `...${tsArrayOf(items)}`,
              ])}`;
            } else {
              output += tsUnionOf(
                Array.from({ length: maxItems - minItems + 1 })
                  .map((_, i) => i + minItems)
                  .map((n) => `${readonly}${tsTupleOf(Array.from({ length: n }).map(() => items))}`)
              );
            }
          } else {
            output += `${readonly}${tsArrayOf(items)}`;
          }
        }
        break;
      }
    }
  }

  // close nullable
  if (node.nullable) {
    output += ") | null";
  }

  return output;
}
