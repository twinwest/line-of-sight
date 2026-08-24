import { memo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { RenderBlock, StoredEvent } from './api';

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

const MD_COMPONENTS = { pre: CodePre };
const MD_REMARK = [remarkGfm];
const MD_REHYPE = [rehypeHighlight];

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
          <pre className="fold-body scrolly">{JSON.stringify(block.input, null, 2)}</pre>
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
      {!toolFlow && (
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
