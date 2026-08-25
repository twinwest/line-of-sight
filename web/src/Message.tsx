import { memo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { RenderBlock, StoredEvent } from './api';
import { diffLines } from './diff';

function copy(text: string): void {
  void navigator.clipboard.writeText(text);
}

function CopyButton({ text, label = 'Copy' }: { text: () => string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="copy-btn" onClick={() => {
      copy(text());
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    }}>{done ? '✓' : label}</button>
  );
}

/** <pre> override: adds a copy button to every fenced code block. */
function CodePre(props: React.HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="codeblock">
      <CopyButton text={() => ref.current?.innerText.replace(/\n$/, '') ?? ''} />
      <pre ref={ref} {...props} />
    </div>
  );
}

/** Links always open in a new tab — never navigate the viewer away. */
function ExtLink({ node: _node, ...props }: React.ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  return <a {...props} target="_blank" rel="noreferrer" />;
}

const MD_COMPONENTS = { pre: CodePre, a: ExtLink };
const MD_REMARK = [remarkGfm];
const MD_REHYPE = [rehypeHighlight];

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const marker = { ctx: ' ', del: '-', add: '+', skip: ' ' } as const;
  return (
    <pre className="fold-body scrolly diff">
      {diffLines(oldText, newText).map((l, i) => (
        <div key={i} className={`diff-line ${l.kind}`}>{marker[l.kind]} {l.text}</div>
      ))}
    </pre>
  );
}

/** Semantic render for file-editing tools; null → fall back to raw JSON. */
function editDiff(toolName: string, input: unknown): React.ReactNode | null {
  const i = (input ?? {}) as Record<string, unknown>;
  if (toolName === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    return <DiffView oldText={i.old_string} newText={i.new_string} />;
  }
  if (toolName === 'Write' && typeof i.content === 'string') {
    return <DiffView oldText="" newText={i.content} />;
  }
  if (toolName === 'MultiEdit' && Array.isArray(i.edits)) {
    const edits = i.edits.filter((e): e is { old_string: string; new_string: string } => {
      const ed = e as Record<string, unknown>;
      return typeof ed.old_string === 'string' && typeof ed.new_string === 'string';
    });
    if (!edits.length) return null;
    return <>{edits.map((e, idx) =>
      <DiffView key={idx} oldText={e.old_string} newText={e.new_string} />)}</>;
  }
  return null;
}

function Block({ block }: { block: RenderBlock }) {
  switch (block.type) {
    case 'text':
      return (
        <div className="md">
          <Markdown remarkPlugins={MD_REMARK} rehypePlugins={MD_REHYPE} components={MD_COMPONENTS}>
            {block.markdown}
          </Markdown>
        </div>
      );
    case 'thinking':
      return (
        <details className="fold thinking">
          <summary>Thinking…</summary>
          <div className="fold-body pre-wrap">{block.text}</div>
        </details>
      );
    case 'tool_use':
      return (
        <details className="fold tool">
          <summary>⏵ {block.summary}</summary>
          {editDiff(block.toolName, block.input)
            ?? <pre className="fold-body scrolly">{JSON.stringify(block.input, null, 2)}</pre>}
        </details>
      );
    case 'tool_result':
      return (
        <details className={`fold tool ${block.isError ? 'is-error' : ''}`}>
          <summary>⏵ {block.isError ? '✗ ' : ''}{block.summary || 'result'}</summary>
          <pre className="fold-body scrolly">{block.output}</pre>
        </details>
      );
    case 'raw':
      return (
        <details className="fold raw">
          <summary>raw block</summary>
          <pre className="fold-body scrolly">{JSON.stringify(block.json, null, 2)}</pre>
        </details>
      );
  }
}

/** The message's own markdown, for Copy Markdown / raw view. */
function messageMarkdown(blocks: RenderBlock[]): string {
  return blocks.map((b) => {
    switch (b.type) {
      case 'text': return b.markdown;
      case 'thinking': return b.text;
      case 'tool_result': return b.output;
      default: return '';
    }
  }).filter(Boolean).join('\n\n');
}

/** A user message whose blocks are all tool_result is part of the tool flow. */
export function isToolFlow(role: string | null, blocks: RenderBlock[]): boolean {
  return role === 'user' && blocks.length > 0 && blocks.every((b) => b.type === 'tool_result' || b.type === 'raw');
}

/** Only prose messages get a head (role label, Copy Markdown, timestamp):
 *  tool_use/thinking-only rows have nothing to copy — a hover head there is
 *  a lie (and an empty spacer line). */
export function hasEventHead(event: StoredEvent): boolean {
  if (event.kind !== 'message' || !Array.isArray(event.body)) return false;
  const blocks = event.body as RenderBlock[];
  return !isToolFlow(event.role, blocks) && blocks.some((b) => b.type === 'text');
}

export const EventRow = memo(function EventRow({ event, showRole = true }:
    { event: StoredEvent; showRole?: boolean }) {
  if (event.kind !== 'message') {
    const body = event.body as { label?: string; raw?: unknown } | null;
    const label = event.kind === 'meta' ? (body?.label ?? 'meta') : 'unknown entry';
    const payload = event.kind === 'meta' && body && 'raw' in body ? body.raw : event.body;
    return (
      <div className="event meta-event" data-mid={event.id}>
        <details className="fold raw">
          <summary>{label}</summary>
          <pre className="fold-body scrolly">{JSON.stringify(payload, null, 2)}</pre>
        </details>
      </div>
    );
  }

  const blocks = event.body as RenderBlock[];
  const toolFlow = isToolFlow(event.role, blocks);
  const roleClass = toolFlow ? 'tool-flow' : event.role;
  const md = () => messageMarkdown(blocks);
  return (
    <div className={`event ${roleClass ?? ''}`} data-mid={event.id}>
      {hasEventHead(event) && (
        <div className="event-head">
          <span className="role">{showRole ? event.role : ''}</span>
          <span className="event-actions">
            <CopyButton text={md} label="Copy Markdown" />
            {event.ts > 0 && <span className="event-ts">
              {new Date(event.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            </span>}
          </span>
        </div>
      )}
      {blocks.map((b, i) => <Block key={i} block={b} />)}
    </div>
  );
});
