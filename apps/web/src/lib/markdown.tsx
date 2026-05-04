// Tiny safe markdown renderer for the legal-document body (UNI-34).
//
// We render a small subset by hand rather than pulling in a dependency:
//   - ATX headings (#, ##, ###, ####)
//   - paragraphs (blank-line separated)
//   - bullet lists with `- ` (one level deep — no nesting)
//   - inline emphasis with `*…*` and `**…**`
//   - inline code with `` `…` ``
//   - inline links with `[text](href)` (only http(s):// or relative URLs)
//
// Any input character that would otherwise turn into HTML is escaped via
// React's text rendering, so customer-authored bodies cannot inject
// raw HTML / scripts. That keeps the surface narrow without bringing in
// a sanitizer.

import type { ReactNode } from "react";

interface InlineToken {
  type: "text" | "code" | "em" | "strong" | "link";
  value: string;
  href?: string;
  children?: InlineToken[];
}

const LINK_PATTERN = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;

function isSafeHref(href: string): boolean {
  if (href.startsWith("/")) return true;
  if (href.startsWith("#")) return true;
  if (/^https?:\/\//i.test(href)) return true;
  if (/^mailto:/i.test(href)) return true;
  return false;
}

function tokenizeInline(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  let i = 0;
  let buf = "";
  const flush = () => {
    if (buf) {
      out.push({ type: "text", value: buf });
      buf = "";
    }
  };
  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);

    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ type: "code", value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (rest.startsWith("**")) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({
          type: "strong",
          value: "",
          children: tokenizeInline(text.slice(i + 2, end)),
        });
        i = end + 2;
        continue;
      }
    }

    if (ch === "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i + 1) {
        flush();
        out.push({
          type: "em",
          value: "",
          children: tokenizeInline(text.slice(i + 1, end)),
        });
        i = end + 1;
        continue;
      }
    }

    if (ch === "_" && (i === 0 || /\s/.test(text[i - 1] ?? " "))) {
      const end = text.indexOf("_", i + 1);
      if (end > i + 1) {
        flush();
        out.push({
          type: "em",
          value: "",
          children: tokenizeInline(text.slice(i + 1, end)),
        });
        i = end + 1;
        continue;
      }
    }

    if (ch === "[") {
      const linkMatch = LINK_PATTERN.exec(rest);
      if (linkMatch) {
        const linkText = linkMatch[1] ?? "";
        const href = linkMatch[2] ?? "";
        if (isSafeHref(href)) {
          flush();
          out.push({
            type: "link",
            value: linkText,
            href,
            children: tokenizeInline(linkText),
          });
          i += linkMatch[0].length;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

function renderInline(tokens: InlineToken[], keyPrefix = ""): ReactNode[] {
  return tokens.map((tok, idx) => {
    const key = `${keyPrefix}${idx}`;
    switch (tok.type) {
      case "code":
        return (
          <code
            key={key}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]"
          >
            {tok.value}
          </code>
        );
      case "strong":
        return (
          <strong key={key} className="font-semibold">
            {renderInline(tok.children ?? [], `${key}.`)}
          </strong>
        );
      case "em":
        return (
          <em key={key} className="italic">
            {renderInline(tok.children ?? [], `${key}.`)}
          </em>
        );
      case "link":
        return (
          <a
            key={key}
            href={tok.href}
            className="underline underline-offset-2 hover:text-primary"
            target={tok.href?.startsWith("http") ? "_blank" : undefined}
            rel={tok.href?.startsWith("http") ? "noopener noreferrer" : undefined}
          >
            {renderInline(tok.children ?? [], `${key}.`)}
          </a>
        );
      default:
        return <span key={key}>{tok.value}</span>;
    }
  });
}

interface BlockSection {
  type: "h1" | "h2" | "h3" | "h4" | "p" | "ul";
  text?: string;
  items?: string[];
}

function parseBlocks(input: string): BlockSection[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: BlockSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("#### ")) {
      blocks.push({ type: "h4", text: line.slice(5).trim() });
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      blocks.push({ type: "h3", text: line.slice(4).trim() });
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ type: "h2", text: line.slice(3).trim() });
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push({ type: "h1", text: line.slice(2).trim() });
      i++;
      continue;
    }
    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("- ")) {
        items.push((lines[i] ?? "").slice(2).trim());
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    // Paragraph: collect consecutive non-blank, non-heading, non-list lines.
    const buf: string[] = [];
    while (i < lines.length) {
      const ln = lines[i] ?? "";
      if (!ln.trim()) break;
      if (/^#{1,4} /.test(ln)) break;
      if (ln.startsWith("- ")) break;
      buf.push(ln);
      i++;
    }
    blocks.push({ type: "p", text: buf.join(" ") });
  }
  return blocks;
}

export function MarkdownView({ source }: { source: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className="space-y-4 text-sm leading-7 text-foreground">
      {blocks.map((block, idx) => {
        const key = `b${idx}`;
        if (block.type === "h1") {
          return (
            <h1
              key={key}
              className="text-2xl font-semibold tracking-tight text-foreground"
            >
              {renderInline(tokenizeInline(block.text ?? ""), `${key}.`)}
            </h1>
          );
        }
        if (block.type === "h2") {
          return (
            <h2
              key={key}
              className="mt-6 text-xl font-semibold tracking-tight"
            >
              {renderInline(tokenizeInline(block.text ?? ""), `${key}.`)}
            </h2>
          );
        }
        if (block.type === "h3") {
          return (
            <h3 key={key} className="mt-4 text-lg font-semibold">
              {renderInline(tokenizeInline(block.text ?? ""), `${key}.`)}
            </h3>
          );
        }
        if (block.type === "h4") {
          return (
            <h4 key={key} className="mt-3 text-base font-semibold">
              {renderInline(tokenizeInline(block.text ?? ""), `${key}.`)}
            </h4>
          );
        }
        if (block.type === "ul") {
          return (
            <ul key={key} className="list-disc space-y-1 pl-6">
              {(block.items ?? []).map((item, j) => (
                <li key={`${key}.${j}`}>
                  {renderInline(tokenizeInline(item), `${key}.${j}.`)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={key} className="text-foreground/90">
            {renderInline(tokenizeInline(block.text ?? ""), `${key}.`)}
          </p>
        );
      })}
    </div>
  );
}
