"use client";

import { cn } from "@/lib/cn";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const assistantComponents: Components = {
  p: ({ children, ...props }) => (
    <p className="mb-2 text-neutral-100 last:mb-0 [&:first-child]:mt-0" {...props}>
      {children}
    </p>
  ),
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }) => <em className="italic text-neutral-200">{children}</em>,
  ul: ({ children, className, ...props }) => (
    <ul
      className={cn(
        "mb-2 last:mb-0",
        String(className ?? "").includes("contains-task-list")
          ? "list-none space-y-2 pl-0 [&_li]:flex [&_li]:items-start [&_li]:gap-2.5 [&_input]:mt-1"
          : "list-disc space-y-1 pl-4 marker:text-[#e67e22]",
        className
      )}
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal space-y-1 pl-5 marker:font-medium marker:text-[#e67e22]/80 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children, className, ...props }) => (
    <li className="leading-snug text-neutral-100" {...props}>
      {children}
    </li>
  ),
  h1: ({ children }) => (
    <h2 className="mb-2 mt-3 border-b border-white/10 pb-1 text-[15px] font-bold leading-tight text-white first:mt-0">
      {children}
    </h2>
  ),
  h2: ({ children }) => (
    <h3 className="mb-1.5 mt-2.5 text-sm font-bold text-white first:mt-0">{children}</h3>
  ),
  h3: ({ children }) => (
    <h4 className="mb-1 mt-2 text-sm font-semibold text-neutral-100 first:mt-0">{children}</h4>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-[#ffbe84] underline decoration-[#e67e22]/50 underline-offset-2 transition hover:text-white"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-[3px] border-[#e67e22]/70 bg-black/25 py-2 pl-3 pr-2 text-sm text-neutral-300 [&_p]:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-white/15" />,
  code: ({ className, children, ...props }) => {
    const block = Boolean(className?.includes("language-"));
    if (block) {
      return (
        <code className={cn("font-mono text-neutral-100", className)} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-black/45 px-1.5 py-0.5 font-mono text-[0.9em] text-[#f0d4b8]"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-xl border border-white/10 bg-black/50 p-3 text-xs leading-relaxed last:mb-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto rounded-lg border border-white/10">
      <table className="min-w-full border-collapse text-left text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-white/[0.06]">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-white/10">{children}</tbody>,
  tr: ({ children }) => <tr className="border-white/5">{children}</tr>,
  th: ({ children }) => (
    <th className="border-b border-white/15 px-2.5 py-2 font-semibold text-neutral-200">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-white/[0.07] px-2.5 py-1.5 text-neutral-300">{children}</td>
  ),
  del: ({ children }) => <del className="text-neutral-500 line-through opacity-90">{children}</del>,
  input: ({ type, ...props }) => {
    if (type === "checkbox") {
      return (
        <input
          type="checkbox"
          className="mt-1 h-3.5 w-3.5 shrink-0 cursor-default rounded border-white/25 bg-[#1a1a1a] accent-[#e67e22]"
          readOnly
          {...props}
        />
      );
    }
    return <input type={type} {...props} />;
  }
};

export function ChatMarkdown({ text }: { text: string }) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  return (
    <div className="chat-md text-sm leading-relaxed [&_.task-list-item]:list-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={assistantComponents}>
        {trimmed}
      </ReactMarkdown>
    </div>
  );
}
