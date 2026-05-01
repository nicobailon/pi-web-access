import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Params = Record<string, string | number>;
type Translate = (key: string, fallback: string, params?: Params) => string;

let translate: Translate = (_key, fallback, params) => format(fallback, params);

function format(text: string, params?: Params): string {
	if (!params) return text;
	return text.replace(/\{(\w+)\}/g, (_match, key: string) => String(params[key] ?? `{${key}}`));
}

export function t(key: string, fallback: string, params?: Params): string {
	return translate(key, fallback, params);
}

const bundles = [
	{
		locale: "ja",
		namespace: "pi-web-access",
		messages: {
			"cmd.curator.review": "検索結果を確認",
			"cmd.activity.toggle": "Web 検索アクティビティを切り替え",
			"cmd.curator.open": "Web 検索キュレーターを開く",
			"cmd.curator.config": "検索キュレーターワークフローを切り替えまたは設定",
			"cmd.gemini.account": "Gemini Web のアクティブな Google アカウントを表示",
			"cmd.storage.browse": "保存済み Web 検索結果を閲覧",
			"notify.curator.opening": "キュレーターを開いています — 残りの検索はストリーミングされます",
			"notify.curator.openingSearch": "Web 検索キュレーターを開いています...",
			"notify.curator.failedConfig": "Web 検索設定の読み込みに失敗しました: {message}",
			"notify.curator.failedOpen": "キュレーターを開けませんでした: {message}",
			"notify.config.unknownOption": "不明なオプション: {option}。on、off、summary-review のいずれかを使用してください。",
			"notify.config.failedSave": "設定の保存に失敗しました: {message}",
			"notify.storage.empty": "保存済み検索結果はありません",
			"notify.storage.deleted": "{id} を削除しました",
			"result.noQuery": "エラー: クエリがありません。'query' または 'queries' パラメーターを使用してください。",
			"result.noUrl": "エラー: URL がありません。",
			"result.fetching": "{count} 件の URL を取得中...",
			"result.searching": "検索中 {index}/{total}: \"{query}\"...",
			"result.searchesComplete": "すべての検索が完了しました — ブラウザーで要約の承認を待っています...",
			"result.curatorStreaming": "検索結果をブラウザーにストリーミング中...",
			"result.waitingApproval": "ブラウザーで要約の承認を待っています...",
			"result.geminiUnavailable": "Gemini Web は利用できません。対応する Chromium 系ブラウザーで gemini.google.com にログインしてください。",
		},
	},
	{
		locale: "zh-CN",
		namespace: "pi-web-access",
		messages: {
			"cmd.curator.review": "审查搜索结果",
			"cmd.activity.toggle": "切换 Web 搜索活动",
			"cmd.curator.open": "打开 Web 搜索 curator",
			"cmd.curator.config": "切换或配置搜索 curator 工作流",
			"cmd.gemini.account": "显示 Gemini Web 当前 Google 账号",
			"cmd.storage.browse": "浏览已保存的 Web 搜索结果",
			"notify.curator.opening": "正在打开 curator — 剩余搜索会继续流式传入",
			"notify.curator.openingSearch": "正在打开 Web 搜索 curator...",
			"notify.curator.failedConfig": "加载 Web 搜索配置失败: {message}",
			"notify.curator.failedOpen": "打开 curator 失败: {message}",
			"notify.config.unknownOption": "未知选项: {option}。请使用 on、off 或 summary-review。",
			"notify.config.failedSave": "保存配置失败: {message}",
			"notify.storage.empty": "没有已保存的搜索结果",
			"notify.storage.deleted": "已删除 {id}",
			"result.noQuery": "错误: 未提供查询。请使用 'query' 或 'queries' 参数。",
			"result.noUrl": "错误: 未提供 URL。",
			"result.fetching": "正在抓取 {count} 个 URL...",
			"result.searching": "正在搜索 {index}/{total}: \"{query}\"...",
			"result.searchesComplete": "所有搜索完成 — 正在浏览器中等待摘要审批...",
			"result.curatorStreaming": "搜索结果正在流式传输到浏览器...",
			"result.waitingApproval": "正在浏览器中等待摘要审批...",
			"result.geminiUnavailable": "Gemini Web 不可用。请在受支持的 Chromium 浏览器中登录 gemini.google.com。",
		},
	},
	{
		locale: "es",
		namespace: "pi-web-access",
		messages: {
			"cmd.curator.review": "Revisar resultados de búsqueda",
			"cmd.activity.toggle": "Alternar actividad de búsqueda web",
			"cmd.curator.open": "Abrir el curador de búsqueda web",
			"cmd.curator.config": "Alternar o configurar el flujo del curador de búsqueda",
			"cmd.gemini.account": "Mostrar la cuenta de Google activa para Gemini Web",
			"cmd.storage.browse": "Explorar resultados de búsqueda web guardados",
			"notify.curator.opening": "Abriendo curador — las búsquedas restantes se transmitirán allí",
			"notify.curator.openingSearch": "Abriendo curador de búsqueda web...",
			"notify.curator.failedConfig": "No se pudo cargar la configuración de búsqueda web: {message}",
			"notify.curator.failedOpen": "No se pudo abrir el curador: {message}",
			"notify.config.unknownOption": "Opción desconocida: {option}. Usa on, off o summary-review.",
			"notify.config.failedSave": "No se pudo guardar la configuración: {message}",
			"notify.storage.empty": "No hay resultados de búsqueda guardados",
			"notify.storage.deleted": "Eliminado {id}",
			"result.noQuery": "Error: no se indicó una consulta. Usa el parámetro 'query' o 'queries'.",
			"result.noUrl": "Error: no se indicó una URL.",
			"result.fetching": "Obteniendo {count} URL(s)...",
			"result.searching": "Buscando {index}/{total}: \"{query}\"...",
			"result.searchesComplete": "Todas las búsquedas terminaron — esperando aprobación del resumen en el navegador...",
			"result.curatorStreaming": "Transmitiendo búsquedas al navegador...",
			"result.waitingApproval": "Esperando aprobación del resumen en el navegador...",
			"result.geminiUnavailable": "Gemini Web no está disponible. Inicia sesión en gemini.google.com en un navegador Chromium compatible.",
		},
	},
];

export function initI18n(pi: ExtensionAPI): void {
	const events = pi.events;
	if (!events) return;
	for (const bundle of bundles) events.emit("pi-core/i18n/registerBundle", bundle);
	events.emit("pi-core/i18n/requestApi", {
		namespace: "pi-web-access",
		callback(api: { t?: Translate } | undefined) {
			if (typeof api?.t === "function") translate = api.t;
		},
	});
}
