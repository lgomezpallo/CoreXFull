export function extractJsonObject(content: string): string {
  const start = content.indexOf("{");
  if (start < 0) return content.trim();

  let depth = 0;
  let insideString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (insideString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        insideString = false;
      }
      continue;
    }

    if (character === "\"") {
      insideString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return content.slice(start, index + 1);
    }
  }

  return content.slice(start).trim();
}

export function parseJsonObject(content: string, errorMessage: string): unknown {
  try {
    return JSON.parse(extractJsonObject(content));
  } catch {
    throw new Error(errorMessage);
  }
}