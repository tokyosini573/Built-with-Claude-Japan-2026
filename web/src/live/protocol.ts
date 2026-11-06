// 「ライブで試す」: 画面と Worker の間でやりとりする形と、条件（teppuri.engine.live.apply_overrides に渡す形）。

export interface VideoInput {
  accounts: number;
  posts_per_account_per_day: number;
  days: number;
  cost_per_video_jpy: number;
  unique_videos_per_account: boolean;
}

export interface LivePlanInput {
  campaign_days: number;
  regions: number[];
  channels: Record<string, number>;
  monthly_jpy: number;
  free_trial_days: number;
  organic_video: VideoInput | null;
}

export interface LiveOverrides {
  runs: number;
  period_days: number;
  plans: { A: LivePlanInput; B: LivePlanInput };
}

/** public/live/manifest.json（scripts/build_live_bundle.py が作る） */
export interface LiveManifest {
  app_id: string;
  name_ja: string;
  version: string;
  files: string[];
  sizes: Record<string, number>;
  total_bytes: number;
  total_gzip_bytes: number;
  defaults: {
    period_days: number;
    runs: number;
    plans: Record<"A" | "B", LivePlanInput & { creatives: string[]; video_creatives: string[] }>;
    video_template: VideoInput;
  };
  decisions: { rows: number; people: number };
}

export type LiveToWorker = { type: "init"; base: string } | { type: "run"; id: number; overrides: LiveOverrides };

export type LiveFromWorker =
  | { type: "progress"; stage: "load" | "run"; text: string; ratio: number }
  | { type: "ready"; loadSeconds: number; pyodide: string }
  | { type: "result"; id: number; json: string; seconds: number }
  | { type: "error"; id?: number; message: string };
