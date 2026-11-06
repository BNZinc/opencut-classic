/**
 * 퀘스티 TA 다리 (questiVideo: 1): the TA app opens this editor in a frame beside its chat and talks
 * to it by postMessage only. The TA keeps each 판 of a video as a plan (edit_video's words: sources
 * cut from start to end in order, a logo, captions) and makes the MP4 itself (ffmpeg); this editor
 * lays a plan out as its timeline, shows where it changed (a bookmark over the changed stretch, the
 * playhead there), and hands the teacher's own edit back as a plan.
 *
 * App → editor: open {plan, changed?} (a 판, or the plan being made while the chat changes it),
 *   seek {at}, get_plan {request}, measure_export {request} (how long this browser takes to export).
 * Editor → app: ready, opened {request?}, plan {request, plan}, time {at}, error {message}.
 */
import { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { buildElementFromMedia, buildTextElement } from "@/timeline/element-utils";
import { DEFAULTS } from "@/timeline/defaults";
import { ToggleBookmarkCommand } from "@/commands/scene/toggle-bookmark";
import { UpdateBookmarkCommand } from "@/commands/scene/update-bookmark";
import { mediaTimeFromSeconds, mediaTimeToSeconds, type MediaTime } from "@/wasm";
import type { MediaAsset } from "@/media/types";
import type { TimelineElement } from "@/timeline";

type Source = { url: string; name?: string; ref: Record<string, string>; start?: number; end?: number };
type Plan = {
	title?: string;
	sources: Source[];
	logo?: { url: string; ref: Record<string, string>; position?: string; size?: number; opacity?: number } | null;
	captions?: { text: string; start: number; end: number }[];
};
type Changed = { at: number; until: number | null; label: string | null };
type Message = { questiVideo: 1; type: string; request?: string; plan?: Plan; changed?: Changed | null; at?: number; files?: Record<string, Blob> };

/** The TA app's own pages (its desktop webview, its web), plus NEXT_PUBLIC_QUESTI_ORIGINS (development). */
const ALLOWED = [
	"tauri://localhost",
	"http://tauri.localhost",
	"https://tauri.localhost",
	"https://questi-ta-web.jollyisland-31ca04f2.koreacentral.azurecontainerapps.io",
	...(process.env.NEXT_PUBLIC_QUESTI_ORIGINS ?? "").split(","),
]
	.map((origin) => origin.trim())
	.filter(Boolean);
/** In the TA's frame: its welcome and news cards stay away. */
export const inQuestiFrame = () => typeof window !== "undefined" && window.parent !== window;
let running: (() => void) | null = null;
/** Our marks: a 판's changed stretch, in the TA's own purple. */
const CHANGED_COLOR = "#4b4fe0";

const seconds = (time: number) => mediaTimeToSeconds({ time: time as MediaTime });
const ticks = (value: number) => mediaTimeFromSeconds({ seconds: Math.max(0, value) });

/** Each link read once: the same 판 laid out again (the chat changing it) does not fetch it again. */
const assets = new Map<string, MediaAsset>();
/** What each asset is in the TA (its attachment or file id), to say the timeline back as a plan. */
const refs = new Map<string, Record<string, string>>();

/** The files the TA handed over with the plan (Blobs by their url): read from the TA's own page, never fetched here. */
let given: Record<string, Blob> = {};

async function assetFor(url: string, name: string, ref: Record<string, string>): Promise<MediaAsset> {
	const known = assets.get(url);
	if (known) return known;
	const editor = EditorCore.getInstance();
	const project = editor.project.getActive();
	if (!project) throw new Error("no project");
	const blob = given[url] ?? (await fetch(url).then((response) => {
		if (!response.ok) throw new Error(`영상을 받지 못했어요 (${response.status})`);
		return response.blob();
	}));
	const file = new File([blob], name, { type: blob.type || "video/mp4" });
	const [processed] = await processMediaAssets({ files: [file] });
	if (!processed) throw new Error("영상을 읽지 못했어요");
	const asset = await editor.media.addMediaAsset({ projectId: project.metadata.id, asset: processed });
	if (!asset) throw new Error("영상을 넣지 못했어요");
	assets.set(url, asset);
	refs.set(asset.id, ref);
	return asset;
}

/** A plan as this editor's timeline: its pieces one after another on the main track, then the logo and captions over them. */
async function layOut(plan: Plan, changed: Changed | null | undefined) {
	const editor = EditorCore.getInstance();
	const scene = editor.scenes.getActiveScene();
	const all = [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio].flatMap((track) => track.elements.map((element) => ({ trackId: track.id, elementId: element.id })));
	if (all.length) editor.timeline.deleteElements({ elements: all });
	// Files of earlier openings this page did not hand over again (a 판 before, another video) go.
	const project = editor.project.getActive();
	const kept = new Set([...assets.values()].map((asset) => asset.id));
	const stale = editor.media.getAssets().filter((asset) => !kept.has(asset.id)).map((asset) => asset.id);
	if (project && stale.length) editor.media.removeMediaAssets({ projectId: project.metadata.id, ids: stale });
	for (const bookmark of scene.bookmarks) editor.command.execute({ command: new ToggleBookmarkCommand(bookmark.time) });

	let at = 0;
	for (const source of plan.sources) {
		const asset = await assetFor(source.url, source.name ?? "영상.mp4", source.ref);
		const length = asset.duration ?? 0;
		const start = Math.min(source.start ?? 0, length);
		const end = Math.min(source.end ?? length, length);
		if (end <= start) continue;
		const element = buildElementFromMedia({ mediaId: asset.id, mediaType: asset.type, name: asset.name, duration: ticks(end - start), startTime: ticks(at) });
		editor.timeline.insertElement({ element: { ...element, trimStart: ticks(start), trimEnd: ticks(length - end) }, placement: { mode: "auto", trackType: "video" } });
		at += end - start;
	}
	if (plan.logo?.url) {
		const logo = await assetFor(plan.logo.url, "logo.png", plan.logo.ref);
		editor.timeline.insertElement({ element: buildElementFromMedia({ mediaId: logo.id, mediaType: "image", name: logo.name, duration: ticks(at), startTime: ticks(0) }), placement: { mode: "auto" } });
	}
	for (const caption of plan.captions ?? []) {
		const text = buildTextElement({ raw: { ...DEFAULTS.text.element, name: caption.text.slice(0, 20), duration: ticks(caption.end - caption.start) }, startTime: ticks(caption.start) });
		editor.timeline.insertElement({ element: { ...text, params: { ...text.params, content: caption.text } }, placement: { mode: "auto", trackType: "text" } });
	}
	if (changed) markChanged(changed);
}

/** 바뀐 곳: a bookmark over the changed stretch (its words as the note), the playhead at its start. */
function markChanged(changed: Changed) {
	const editor = EditorCore.getInstance();
	const time = ticks(changed.at);
	editor.command.execute({ command: new ToggleBookmarkCommand(time) });
	editor.command.execute({
		command: new UpdateBookmarkCommand({ time, updates: { note: changed.label ?? "바뀐 곳", color: CHANGED_COLOR, ...(changed.until !== null && changed.until > changed.at ? { duration: ticks(changed.until - changed.at) } : {}) } }),
	});
	editor.playback.seek({ time });
}

/** The timeline as a plan: the main track's pieces in order, an image as the logo, text as captions. */
function planNow(): Plan {
	const editor = EditorCore.getInstance();
	const scene = editor.scenes.getActiveScene();
	const media = new Map(editor.media.getAssets().map((asset) => [asset.id, asset]));
	const pieces = [...scene.tracks.main.elements].sort((a, b) => a.startTime - b.startTime);
	const sources = pieces
		.filter((element) => element.type === "video" && refs.has(element.mediaId))
		.map((element) => ({ url: media.get((element as { mediaId: string }).mediaId)?.url ?? "", ref: refs.get((element as { mediaId: string }).mediaId)!, start: seconds(element.trimStart), end: seconds(element.trimStart + element.duration) }));
	const overlay: TimelineElement[] = scene.tracks.overlay.flatMap((track) => [...track.elements] as TimelineElement[]);
	const image = overlay.find((element) => element.type === "image" && refs.has((element as { mediaId: string }).mediaId)) as { mediaId: string } | undefined;
	const captions = overlay
		.filter((element) => element.type === "text")
		.map((element) => ({ text: String((element.params as Record<string, unknown>).content ?? ""), start: seconds(element.startTime), end: seconds(element.startTime + element.duration) }))
		.filter((caption) => caption.text.trim());
	return { sources, ...(image ? { logo: { url: "", ref: refs.get(image.mediaId)! } } : {}), ...(captions.length ? { captions } : {}) };
}

export function startQuestiBridge() {
	if (!inQuestiFrame() || running) return () => {};
	let origin: string | null = null;
	const tell = (body: Record<string, unknown>): void => {
		if (origin) window.parent.postMessage({ questiVideo: 1, ...body }, origin);
	};
	let working: Promise<void> = Promise.resolve();
	const onMessage = (event: MessageEvent) => {
		const data = event.data as Message;
		if (!data || data.questiVideo !== 1 || event.source !== window.parent) return;
		if (!ALLOWED.includes(event.origin)) return;
		origin = event.origin;
		const run = (work: () => Promise<void> | void) => {
			working = working.then(work).catch((error: unknown) => tell({ type: "error", request: data.request, message: error instanceof Error ? error.message : String(error) }));
		};
		if (data.type === "open" && data.plan) run(async () => {
			given = { ...given, ...(data.files ?? {}) };
			await layOut(data.plan!, data.changed);
			tell({ type: "opened", request: data.request });
		});
		if (data.type === "seek" && typeof data.at === "number") run(() => EditorCore.getInstance().playback.seek({ time: ticks(data.at!) }));
		if (data.type === "get_plan") run(() => tell({ type: "plan", request: data.request, plan: planNow() }));
		if (data.type === "measure_export") run(async () => {
			const started = performance.now();
			const result = await EditorCore.getInstance().renderer.exportProject({ options: { format: "mp4", quality: "high", includeAudio: true } });
			tell({ type: "measured", request: data.request, ms: Math.round(performance.now() - started), ok: result.success, bytes: result.success && result.buffer ? result.buffer.byteLength : 0, error: result.success ? null : result.error });
		});
	};
	window.addEventListener("message", onMessage);
	// Where it plays, for "여기서 잘라 줘" (a few times a second at most, when it moves).
	let last = -1;
	const timer = window.setInterval(() => {
		const now = Math.round(seconds(EditorCore.getInstance().playback.getCurrentTime()) * 10) / 10;
		if (now !== last) tell({ type: "time", at: (last = now) });
	}, 250);
	// Only "ready" goes before the TA has spoken (it names no data); everything else to the TA's origin.
	window.parent.postMessage({ questiVideo: 1, type: "ready" }, "*");
	running = () => {
		window.removeEventListener("message", onMessage);
		window.clearInterval(timer);
		running = null;
	};
	return running;
}
