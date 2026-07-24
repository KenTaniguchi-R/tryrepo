"use client";

import { useRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";

/**
 * Renders the agent's code-reading steps instead of leaving them as generic
 * tool chrome. The claim behind repo Q&A is "it reads the code rather than
 * guessing" -- showing the actual files and matched lines is what makes that
 * checkable by the user rather than something they have to take on trust.
 */

type ReadPayload = { status?: string; path?: string; lines?: string; truncated?: boolean; error?: string };
type GrepPayload = { status?: string; matches?: string[]; truncated?: boolean; error?: string };

/**
 * CopilotKit is inconsistent about whether a tool result arrives as a JSON
 * string or the object itself, so accept either. Assuming one shape makes
 * every successful call render as a failure.
 */
function parse<T>(result: unknown): T {
  if (typeof result === "string") {
    try {
      return JSON.parse(result) as T;
    } catch {
      return {} as T;
    }
  }
  if (result && typeof result === "object") return result as T;
  return {} as T;
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-neutral-200 rounded-xl overflow-hidden text-xs">{children}</div>
  );
}

function Header({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-50 border-b border-neutral-200">
      <span className="text-neutral-500">{label}</span>
      {detail && <span className="font-mono truncate">{detail}</span>}
    </div>
  );
}

function Pending({ label, detail }: { label: string; detail?: string }) {
  return (
    <Card>
      <Header label={label} detail={detail} />
    </Card>
  );
}

export function RepoReadTools() {
  useRenderTool({
    name: "readFile",
    parameters: z.object({ path: z.string().optional() }),
    render: (props) => {
      const path = props.parameters?.path;
      if (props.status !== "complete") return <Pending label="Reading" detail={path} />;

      const data = parse<ReadPayload>(props.result);
      if (data.status !== "ok" || !data.lines) {
        return (
          <Card>
            <Header label="Could not read" detail={path} />
          </Card>
        );
      }

      // readRepoFile returns "<lineNo>\t<text>" per line; keep it to a preview
      // so a 400-line read doesn't bury the conversation.
      const all = data.lines.split("\n");
      const shown = all.slice(0, 12);

      return (
        <Card>
          <Header label="Read" detail={data.path ?? path} />
          <pre className="px-3 py-2 overflow-x-auto bg-[#0a0a0a] text-neutral-200 leading-relaxed">
            {shown.join("\n")}
          </pre>
          {(all.length > shown.length || data.truncated) && (
            <div className="px-3 py-1.5 text-neutral-400 border-t border-neutral-200">
              +{all.length - shown.length} more lines read
            </div>
          )}
        </Card>
      );
    },
  });

  useRenderTool({
    name: "grepRepo",
    parameters: z.object({ pattern: z.string().optional() }),
    render: (props) => {
      const pattern = props.parameters?.pattern;
      if (props.status !== "complete") return <Pending label="Searching for" detail={pattern} />;

      const data = parse<GrepPayload>(props.result);
      const matches = data.matches ?? [];
      if (data.status !== "ok") {
        return (
          <Card>
            <Header label="Search failed" detail={pattern} />
          </Card>
        );
      }

      return (
        <Card>
          <Header label={`${matches.length} match${matches.length === 1 ? "" : "es"} for`} detail={pattern} />
          {matches.length > 0 && (
            <ul className="px-3 py-2 flex flex-col gap-0.5 font-mono overflow-x-auto">
              {matches.slice(0, 8).map((m, i) => (
                <li key={i} className="truncate text-neutral-600">
                  {m}
                </li>
              ))}
            </ul>
          )}
        </Card>
      );
    },
  });

  return null;
}
