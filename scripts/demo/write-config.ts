/**
 * Demo-only: write a realistic config.js for instance a or b.
 *   node --import tsx scripts/demo/write-config.ts <crossSeedDir> <a|b> <dataRoot> <mockBase> <port>
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderConfigFile, templateConfig } from "../../packages/shared/src/index.ts";

const [dir, inst, root, mock, port] = process.argv.slice(2);
const key = "demo0prowlarr0key0123456789abcdef";
const ids = inst === "a" ? [1, 2, 3, 4, 5, 6] : [2, 3, 5, 6];
const config = {
	...templateConfig(),
	torznab: ids.map((i) => `${mock}/${i}/api?apikey=${key}`),
	sonarr: inst === "a" ? [`${mock}/sonarr/?apikey=demo0sonarr0key0123456789abcd`] : [],
	radarr: [`${mock}/radarr/?apikey=demo0radarr0key0123456789abcd`],
	host: "127.0.0.1",
	port: Number(port),
	notificationWebhookUrls: [`${mock}/notify/demo0apprise0token0123456789ab`],
	torrentClients: [`qbittorrent:http://admin:demo%40pass@127.0.0.1:${new URL(mock).port}/qbit/${inst}`],
	useClientTorrents: true,
	delay: 30,
	linkDirs: [join(root, inst, "links")],
	linkType: "hardlink",
	matchMode: "partial",
	seasonFromEpisodes: 1,
	rssCadence: "10 minutes",
	searchCadence: "1 day",
	excludeOlder: "2 weeks",
	excludeRecentSearch: "3 days",
	searchLimit: 400,
	blockList: ["category:music", "nameRegex:\\b(CAM|HDTS|TELESYNC)\\b", "sizeBelow:104857600"],
};
writeFileSync(join(dir, "config.js"), renderConfigFile(config, { note: "demo configuration" }));
console.log(`[demo] config.js for ${inst}`);
