import { createContext, memo, useContext, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import {
  genericDialect, type AskQuestion, type Dialect, type Plumbing,
} from '../../src/shared/dialects';
import { nav } from './App';
import type { RenderBlock, SessionMeta, StoredEvent } from './api';
import { type ToolOutcome } from '../../src/shared/outcomes';
import { diffLines } from './diff';

/** tool_use id → result pairing plus "which event is the CLI parked on",
 *  built once per merge in SessionView. A context, not a prop, so the
 *  memoized EventRow shells skip reconciling on each SSE append; the Blocks
 *  inside (tool folds, cards) subscribe — an action is one row, so a use
 *  fold renders its own result and the result's carrier row renders empty. */
export const OutcomesCtx = createContext<{
  outcomes: Map<string, ToolOutcome>;
  useIds: Set<string>;
  pendingEventId: string | null;
  /** tool_use id → the subagent session that call spawned (Task rows). */
  subagents: Map<string, SessionMeta>;
}>({ outcomes: new Map(), useIds: new Set(), pendingEventId: null, subagents: new Map() });

/** The viewed session's presentation policy (see src/shared/dialects/).
 *  Default = generic: an unprovided tree renders every tool as a plain fold —
 *  fail-open, never a crash. */
export const DialectCtx = createContext<Dialect>(genericDialect);

function copy(text: string): void {
  void navigator.clipboard.writeText(text);
}

export function CopyButton({ text, label = 'Copy', doneLabel = '✓', onCopied }:
    { text: () => string; label?: string; doneLabel?: string; onCopied?: () => void }) {
  const [done, setDone] = useState(false);
  return (
    <button className="copy-btn" onClick={() => {
      copy(text());
      setDone(true);
      setTimeout(() => setDone(false), 1200);
      onCopied?.();
    }}>{done ? doneLabel : label}</button>
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

/** Shared with the side panel: answers are markdown too, and SPEC §5.3 wants a
 *  Copy button on every code block wherever it renders. */
export const MD_COMPONENTS = { pre: CodePre, a: ExtLink };
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

type ToolUseBlock = Extract<RenderBlock, { type: 'tool_use' }>;

/** Question card (claude: AskUserQuestion) — read-only mirror of the CLI's question UI: same structure
 *  (header chip, options with descriptions, previews), chosen option marked
 *  once the answer lands. A free-text ("Other") answer shows as its own row. */
function AskCard({ block, questions, eventId }: {
  block: ToolUseBlock; questions: AskQuestion[]; eventId: string;
}) {
  const { outcomes, pendingEventId } = useContext(OutcomesCtx);
  const dialect = useContext(DialectCtx);
  const outcome = block.id ? outcomes.get(block.id) : undefined;
  const waiting = !outcome && eventId === pendingEventId;
  return (
    <div className={`ask-card ${waiting ? 'pending' : ''}`}>
      <div className="card-status">
        {waiting ? '✋ waiting for your answer in the CLI'
          : outcome ? (outcome.isError ? 'question · dismissed' : 'question · answered')
          : 'question'}
      </div>
      {questions.map((q, qi) => {
        const answer = outcome && !outcome.isError ? dialect.chosenAnswer(outcome.output, q) : null;
        const picked = (label: string) => answer !== null
          && (answer === label || (q.multiSelect && answer.split(', ').includes(label)));
        return (
          <div className="ask-q" key={qi}>
            <div>
              {q.header && <span className="ask-header">{q.header}</span>}
              <span className="ask-question">{q.question}</span>
            </div>
            {q.options.map((opt, oi) => (
              <div key={oi} className={`ask-option ${picked(opt.label) ? 'picked' : ''}`}>
                <div>{picked(opt.label) && '✓ '}{opt.label}</div>
                {opt.description && <div className="ask-desc">{opt.description}</div>}
                {opt.preview !== undefined && (
                  <details className="fold">
                    <summary>⏵ preview</summary>
                    <pre className="fold-body scrolly pre-wrap">{opt.preview}</pre>
                  </details>
                )}
              </div>
            ))}
            {answer !== null && !q.options.some((o) => picked(o.label)) && (
              <div className="ask-option picked"><div>✓ {answer}</div></div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Plan card (claude: ExitPlanMode): the plan is a document the user must read to decide, so it
 *  renders in full — pending and after — with the approval state on top. */
function PlanCard({ block, eventId }: { block: ToolUseBlock; eventId: string }) {
  const { outcomes, pendingEventId } = useContext(OutcomesCtx);
  const dialect = useContext(DialectCtx);
  const outcome = block.id ? outcomes.get(block.id) : undefined;
  const plan = dialect.planMarkdown(block.input, outcome?.output ?? null);
  const waiting = !outcome && eventId === pendingEventId;
  return (
    <div className={`plan-card ${waiting ? 'pending' : ''} ${outcome?.isError ? 'rejected' : ''}`}>
      <div className="card-status">
        {waiting ? '✋ plan awaiting your approval in the CLI'
          : outcome ? (outcome.isError ? 'plan · rejected' : 'plan · approved')
          : 'plan'}
        {plan !== null && <CopyButton text={() => plan} label="Copy Markdown" />}
      </div>
      {plan !== null
        ? <div className="md">
            <Markdown remarkPlugins={MD_REMARK} rehypePlugins={MD_REHYPE} components={MD_COMPONENTS}>
              {plan}
            </Markdown>
          </div>
        : <pre className="fold-body scrolly">{JSON.stringify(block.input, null, 2)}</pre>}
    </div>
  );
}

/** A plan-draft write (dialect.planDraft) — the plan being drafted, visible
 *  before the (batch-flushed) blocking plan use can land. No outcome/pending
 *  logic: the write returns in milliseconds, there is no waiting state. */
function PlanDraftCard({ content }: { content: string }) {
  return (
    <div className="plan-card">
      <div className="card-status">
        plan · draft
        <CopyButton text={() => content} label="Copy Markdown" />
      </div>
      <div className="md">
        <Markdown remarkPlugins={MD_REMARK} rehypePlugins={MD_REHYPE} components={MD_COMPONENTS}>
          {content}
        </Markdown>
      </div>
    </div>
  );
}

/** Opens the transcript of the subagent a Task call spawned. Sits on the
 *  tool_use fold — or, when a batch of parallel Tasks wrote only their results
 *  and no use ever reached the transcript, on the orphan tool_result instead. */
function SubagentLink({ child }: { child: SessionMeta }) {
  return (
    <a className="subagent-link" href={`/s/${child.id}`}
       title={`open the subagent transcript (${child.messageCount} messages)`}
       onClick={(e) => { e.preventDefault(); e.stopPropagation(); nav(`/s/${child.id}`); }}>
      transcript ↗
    </a>
  );
}

function Block({ block, eventId }: { block: RenderBlock; eventId: string }) {
  const { outcomes, useIds, subagents } = useContext(OutcomesCtx);
  const dialect = useContext(DialectCtx);
  switch (block.type) {
    case 'text':
      return (
        <div className="md">
          <Markdown remarkPlugins={MD_REMARK} rehypePlugins={MD_REHYPE} components={MD_COMPONENTS}>
            {block.markdown}
          </Markdown>
        </div>
      );
    case 'thinking': {
      // first line as information scent; CSS ellipsis handles the length
      const preview = block.text.trimStart().split('\n', 1)[0] ?? '';
      return (
        <details className="fold thinking">
          <summary>✻ {preview || 'Thinking…'}</summary>
          <div className="fold-body pre-wrap">{block.text}</div>
        </details>
      );
    }
    case 'tool_use': {
      // agent-specific cards (questions, plans, drafts) come from the
      // dialect; shape drift → generic fold
      const questions = dialect.askQuestions(block);
      if (questions) return <AskCard block={block} questions={questions} eventId={eventId} />;
      if (dialect.isPlanUse(block)) {
        return <PlanCard block={block} eventId={eventId} />;
      }
      const draft = dialect.planDraft(block);
      if (draft !== null) {
        return <PlanDraftCard content={draft} />;
      }
      // one action = one row: the fold owns its result (SPEC C2 "click to
      // expand full input/output"); summary is "Name arg" (adapter's
      // toolSummary) — split so the name can sit in its own register
      const arg = block.summary.startsWith(block.toolName)
        ? block.summary.slice(block.toolName.length).trim() : block.summary;
      const result = block.id ? outcomes.get(block.id) : undefined;
      // a Task call has its own transcript — the fold shows the report it
      // handed back, the link opens the run that produced it
      const child = block.id ? subagents.get(block.id) : undefined;
      return (
        <details className={`fold tool ${result?.isError ? 'is-error' : ''}`}>
          <summary>
            <span className="fold-label">
              ⏵ <span className="tool-name">{block.toolName}</span>
              {arg && <span className="tool-arg"> {arg}</span>}
              {result?.isError && ' ✗'}
            </span>
            {child && <SubagentLink child={child} />}
          </summary>
          {dialect.editDiff(block)?.map((p, idx) =>
            <DiffView key={idx} oldText={p.oldText} newText={p.newText} />)
            ?? <pre className="fold-body scrolly">{JSON.stringify(block.input, null, 2)}</pre>}
          {result && <pre className="fold-body scrolly">{result.output}</pre>}
        </details>
      );
    }
    case 'tool_result':
      // normally absorbed into its use's fold above; orphans (use outside the
      // loaded window, pre-id ingests, drift) still render — never drop content
      if (block.toolUseId && useIds.has(block.toolUseId)) return null;
      // an orphan whose id names a subagent run IS that Task's only row here
      const orphanChild = block.toolUseId ? subagents.get(block.toolUseId) : undefined;
      return (
        <details className={`fold tool ${block.isError ? 'is-error' : ''}`}>
          <summary>
            <span className="fold-label">⏵ {block.isError ? '✗ ' : ''}{block.summary || 'result'}</span>
            {orphanChild && <SubagentLink child={orphanChild} />}
          </summary>
          <pre className="fold-body scrolly">{block.output}</pre>
        </details>
      );
    case 'raw':
      return (
        <details className="fold raw">
          <summary>⏵ raw block</summary>
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

/** CLI-plumbing user message (task notifications, command wrappers, …). */
function plumbingOf(event: StoredEvent, dialect: Dialect): Plumbing | null {
  if (event.kind !== 'message' || event.role !== 'user' || !Array.isArray(event.body)) return null;
  const first = (event.body as RenderBlock[]).find((b) => b.type === 'text');
  return first?.type === 'text' ? dialect.plumbing(first.markdown) : null;
}

/** Only prose messages get a head (role label, Copy Markdown, timestamp):
 *  tool_use/thinking-only rows have nothing to copy — a hover head there is
 *  a lie (and an empty spacer line). Plumbing is not the user speaking. */
export function hasEventHead(event: StoredEvent, dialect: Dialect): boolean {
  if (event.kind !== 'message' || !Array.isArray(event.body)) return false;
  const blocks = event.body as RenderBlock[];
  return !isToolFlow(event.role, blocks)
    && blocks.some((b) => b.type === 'text')
    && !plumbingOf(event, dialect);
}

export const EventRow = memo(function EventRow({ event, showRole = true }:
    { event: StoredEvent; showRole?: boolean }) {
  const dialect = useContext(DialectCtx);
  if (event.kind !== 'message') {
    const body = event.body as { label?: string; raw?: unknown } | null;
    const label = event.kind === 'meta' ? (body?.label ?? 'meta') : 'unknown entry';
    const payload = event.kind === 'meta' && body && 'raw' in body ? body.raw : event.body;
    return (
      <div className="event meta-event" data-mid={event.id}>
        <details className="fold raw">
          <summary>⏵ {label}</summary>
          <pre className="fold-body scrolly">{JSON.stringify(payload, null, 2)}</pre>
        </details>
      </div>
    );
  }

  const blocks = event.body as RenderBlock[];

  // plumbing user lines render as a fold, never as user speech
  const plumbing = plumbingOf(event, dialect);
  if (plumbing) {
    const label = plumbing.label.length > 100 ? plumbing.label.slice(0, 99) + '…' : plumbing.label;
    const rawText = blocks.find((b) => b.type === 'text');
    return (
      <div className="event tool-flow" data-mid={event.id}>
        <details className="fold tool">
          <summary>⏵ {label}</summary>
          {plumbing.result !== null
            ? <div className="md fold-body">
                <Markdown remarkPlugins={MD_REMARK} rehypePlugins={MD_REHYPE} components={MD_COMPONENTS}>
                  {plumbing.result}
                </Markdown>
              </div>
            : <pre className="fold-body scrolly pre-wrap">
                {rawText?.type === 'text' ? rawText.markdown : ''}
              </pre>}
        </details>
      </div>
    );
  }

  const toolFlow = isToolFlow(event.role, blocks);
  const roleClass = toolFlow ? 'tool-flow' : event.role;
  const md = () => messageMarkdown(blocks);
  return (
    <div className={`event ${roleClass ?? ''}`} data-mid={event.id}>
      {hasEventHead(event, dialect) && (
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
      {blocks.map((b, i) => <Block key={i} block={b} eventId={event.id} />)}
    </div>
  );
});
