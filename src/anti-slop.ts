export interface SlopIssue {
  line: number;
  rule:
    | "todo_stub"
    | "placeholder_truncation"
    | "unimplemented_throw"
    | "blind_any_cast"
    | "empty_catch";
  severity: "error" | "warning";
  message: string;
  excerpt: string;
}

export interface SlopAuditReport {
  filePath: string;
  clean: boolean;
  issues: SlopIssue[];
}

/**
 * Audits source code for common AI Slop anti-patterns:
 * - Lazy truncation comments (`// ... rest of code`, `// existing code here`)
 * - Unfinished `// TODO: implement` stubs
 * - `throw new Error("Not implemented")`
 * - Blind `as any` or `: any` in TypeScript
 */
export function auditCodeForSlop(filePath: string, content: string): SlopAuditReport {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const issues: SlopIssue[] = [];
  const isTs = /\.(ts|tsx)$/i.test(filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (/\/\/\s*\.\.\.\s*(rest of|existing|remaining|keep|other)\b/i.test(trimmed)) {
      issues.push({
        line: i + 1,
        rule: "placeholder_truncation",
        severity: "error",
        message: "Lazy AI placeholder comment truncating implementation code",
        excerpt: trimmed.slice(0, 120),
      });
    }

    if (/\/\/\s*(TODO|FIXME):\s*(implement|add|write|complete|fill)/i.test(trimmed)) {
      issues.push({
        line: i + 1,
        rule: "todo_stub",
        severity: "error",
        message: "Unfinished TODO stub left in implementation",
        excerpt: trimmed.slice(0, 120),
      });
    }

    if (/throw\s+new\s+Error\(\s*["'`]not\s+implemented/i.test(trimmed)) {
      issues.push({
        line: i + 1,
        rule: "unimplemented_throw",
        severity: "error",
        message: "Unimplemented function stub throwing 'Not implemented'",
        excerpt: trimmed.slice(0, 120),
      });
    }

    if (isTs && /(\bas\s+any\b|:\s*any\b)/.test(trimmed) && !trimmed.startsWith("//")) {
      issues.push({
        line: i + 1,
        rule: "blind_any_cast",
        severity: "warning",
        message: "Avoid `any` in TypeScript; use `unknown` or explicit interfaces",
        excerpt: trimmed.slice(0, 120),
      });
    }
  }

  return {
    filePath,
    clean: issues.filter((x) => x.severity === "error").length === 0,
    issues,
  };
}
