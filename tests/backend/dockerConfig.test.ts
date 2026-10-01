import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
const turnTemplatePath = new URL("../../deploy/coturn/turnserver.conf", import.meta.url);
const coturnEntrypointPath = new URL("../../deploy/coturn/entrypoint.sh", import.meta.url);
const turnTemplate = existsSync(turnTemplatePath) ? readFileSync(turnTemplatePath, "utf8") : "";
const coturnEntrypoint = existsSync(coturnEntrypointPath) ? readFileSync(coturnEntrypointPath, "utf8") : "";

describe("Docker TURN relay configuration", () => {
	it("shares the file-backed TURN secret with signalling and coturn", () => {
		expect(compose).toMatch(/nakiri-signalling:[\s\S]*?secrets:[\s\S]*?turn_secret/);
		expect(compose).toMatch(/coturn:[\s\S]*?secrets:[\s\S]*?turn_secret/);
		expect(compose).toMatch(/TURN_SECRET_FILE:\s*\/run\/secrets\/turn_secret/);
		expect(compose).toMatch(/source:\s*turn_secret[\s\S]*?target:\s*turn_secret/);
		expect(compose).toMatch(/file:\s*\$\{TURN_SECRET_FILE\?:\?/);
	});

	it("publishes direct TURN listeners and the bounded relay range", () => {
		expect(compose).toMatch(/3478:3478\/udp/);
		expect(compose).toMatch(/3478:3478\/tcp/);
		expect(compose).toMatch(/49160-49200:49160-49200\/udp/);
		expect(compose).toMatch(/TURN_URLS/);
		expect(turnTemplate).toMatch(/min-port=49160/);
		expect(turnTemplate).toMatch(/max-port=49200/);
	});

	it("keeps the tracked coturn template secret-free and denies anonymous use", () => {
		expect(turnTemplate).toMatch(/no-anonymous/);
		expect(turnTemplate).not.toMatch(/static-auth-secret\s*=/);
		expect(turnTemplate).not.toMatch(/secret/i);
	});

	it("renders authentication from the mounted secret into a private runtime config", () => {
		expect(coturnEntrypoint).toContain("/run/secrets/turn_secret");
		expect(coturnEntrypoint).toMatch(/use-auth-secret/);
		expect(coturnEntrypoint).toMatch(/static-auth-secret/);
		expect(coturnEntrypoint).toMatch(/chmod 600/);
	});
});
