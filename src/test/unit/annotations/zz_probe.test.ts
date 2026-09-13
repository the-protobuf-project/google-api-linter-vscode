import { test } from "bun:test";
import { referenceRegistry } from "../support/fixtures";

test("probe", async () => {
	const reg = await referenceRegistry();
	for (const d of reg.all()) {
		const body = reg.body(d);
		const n = body?.fields.length ?? 0;
		console.log(
			`${d.fqn} target=${d.target} type=${d.type} rep=${d.repeated} bodyFields=${n} import=${d.importPath}`,
		);
		if (body && n <= 6) {
			const ns = body.fqn.slice(0, body.fqn.lastIndexOf("."));
			for (const f of body.fields) {
				const e = reg.resolveEnumFqn(f.type, ns);
				console.log(
					`    ${f.name}: ${f.type} rep=${f.repeated} msg=${f.messageFqn ?? "-"} enum=${e ?? "-"}${e ? `(${reg.enumValues(e)?.length})` : ""}`,
				);
			}
		}
	}
	console.log("IdStrategy", reg.enumValues("orm.v1.IdStrategy"));
	console.log("Strategy", reg.enumValues("cache.v1.Strategy"));
});
