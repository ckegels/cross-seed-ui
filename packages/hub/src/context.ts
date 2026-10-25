import type { LoginThrottle, Sessions } from "./auth.ts";
import type { SecretBox } from "./crypto.ts";
import type { HubDb } from "./db.ts";
import type { HubSettings } from "./settings.ts";

export interface HubContext {
	settings: HubSettings;
	version: string;
	db: HubDb;
	box: SecretBox;
	sessions: Sessions;
	throttle: LoginThrottle;
}
