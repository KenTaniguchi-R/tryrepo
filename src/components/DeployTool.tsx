"use client";

import { useEffect } from "react";
import { useRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";

type DeployPayload = {
  status?: string;
  previewUrl?: string;
  workspaceId?: string;
  error?: string;
};

function parse(result: string): DeployPayload {
  try {
    return JSON.parse(result) as DeployPayload;
  } catch {
    return {};
  }
}

export function DeployTool({
  onDeployed,
}: {
  onDeployed: (deploy: { workspaceId: string; previewUrl: string }) => void;
}) {
  useRenderTool(
    {
      name: "deployRepo",
      parameters: z.object({ repoUrl: z.string() }),
      render: (props) => {
        if (props.status !== "complete") {
          return (
            <div className="border border-neutral-200 rounded-2xl px-4 py-3 text-sm text-neutral-500">
              Deploying <span className="font-mono">{props.parameters?.repoUrl ?? "the repo"}</span>…
            </div>
          );
        }

        const data = parse(props.result);
        if (data.status !== "success" || !data.previewUrl || !data.workspaceId) {
          return (
            <div className="border border-red-200 bg-red-50 rounded-2xl px-4 py-3 text-sm text-red-700">
              Deploy failed: {data.error ?? "unknown error"}
            </div>
          );
        }

        return (
          <DeployReady
            workspaceId={data.workspaceId}
            previewUrl={data.previewUrl}
            onDeployed={onDeployed}
          />
        );
      },
    },
    [onDeployed]
  );

  return null;
}

function DeployReady({
  workspaceId,
  previewUrl,
  onDeployed,
}: {
  workspaceId: string;
  previewUrl: string;
  onDeployed: (deploy: { workspaceId: string; previewUrl: string }) => void;
}) {
  useEffect(() => {
    onDeployed({ workspaceId, previewUrl });
  }, [workspaceId, previewUrl, onDeployed]);

  return (
    <div className="border border-neutral-200 rounded-2xl px-4 py-3 text-sm text-neutral-500">
      Live in the panel beside the chat.
    </div>
  );
}
