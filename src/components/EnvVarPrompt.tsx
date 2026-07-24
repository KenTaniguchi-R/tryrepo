"use client";

import { useState } from "react";
import { useHumanInTheLoop } from "@copilotkit/react-core/v2";
import { z } from "zod";

const EnvVarSchema = z.object({
  vars: z.array(
    z.object({
      name: z.string().describe("Environment variable name"),
      description: z.string().describe("What it's for and where to get it"),
      required: z.boolean().describe("Whether the app can run without it"),
    })
  ),
});

type Vars = z.infer<typeof EnvVarSchema>["vars"];

function Form({
  vars,
  onSubmit,
  onSkip,
}: {
  vars: Vars;
  onSubmit: (values: Record<string, string>) => void;
  onSkip: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const missingRequired = vars.some((v) => v.required && !values[v.name]?.trim());

  if (submitted) {
    return (
      <div className="border border-neutral-200 rounded-2xl px-4 py-3 text-sm text-neutral-500">
        Values submitted.
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        onSubmit(values);
      }}
      className="border border-neutral-200 rounded-2xl p-4 flex flex-col gap-3 text-sm"
    >
      <div>
        <p className="font-medium">This project needs some configuration</p>
        <p className="text-xs text-neutral-500 mt-0.5">
          Values are used only to build and run this throwaway sandbox, which is deleted
          after 30 minutes. Don&apos;t paste production secrets.
        </p>
      </div>

      {vars.map((v) => (
        <label key={v.name} className="flex flex-col gap-1">
          <span className="font-mono text-xs">
            {v.name}
            {v.required ? (
              <span className="text-red-600"> *</span>
            ) : (
              <span className="text-neutral-400"> (optional)</span>
            )}
          </span>
          <span className="text-xs text-neutral-500">{v.description}</span>
          <input
            type="password"
            autoComplete="off"
            value={values[v.name] ?? ""}
            onChange={(e) => setValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
            className="border border-neutral-200 rounded-lg px-3 py-1.5 font-mono text-xs focus:outline-none focus:border-neutral-400"
          />
        </label>
      ))}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={missingRequired}
          className="bg-emerald-700 text-white rounded-full px-4 py-1.5 text-xs disabled:bg-neutral-200 disabled:text-neutral-400"
        >
          Deploy with these
        </button>
        <button
          type="button"
          onClick={() => {
            setSubmitted(true);
            onSkip();
          }}
          className="border border-neutral-200 rounded-full px-4 py-1.5 text-xs hover:bg-neutral-100"
        >
          Skip
        </button>
      </div>
    </form>
  );
}

/**
 * Registers the human-in-the-loop step the agent uses to ask for a repo's
 * required environment variables. The agent pauses mid-flow (analyze -> ask ->
 * deploy) until the user submits or skips.
 */
export function EnvVarPrompt() {
  useHumanInTheLoop({
    name: "collectEnvVars",
    description:
      "Ask the user to supply the environment variables a repo needs before deploying it. " +
      "Pass the exact list returned by analyzeRepo's requiredEnvVars. Never invent values yourself.",
    parameters: EnvVarSchema,
    render: ({ args, respond }) => {
      if (!respond) return <></>;
      const vars = args?.vars ?? [];
      if (vars.length === 0) return <></>;

      return (
        <Form
          vars={vars}
          onSubmit={(values) =>
            respond({
              provided: true,
              envVars: Object.fromEntries(
                Object.entries(values).filter(([, value]) => value.trim() !== "")
              ),
            })
          }
          onSkip={() =>
            respond({
              provided: false,
              envVars: {},
              note: "User skipped -- deploy may fail without these.",
            })
          }
        />
      );
    },
  });

  return null;
}
