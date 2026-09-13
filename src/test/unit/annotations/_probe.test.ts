import { test } from "bun:test";
import { referenceRegistry } from "../support/fixtures";
import { importClosure } from "../../../annotations/resolve";

test("probe", async () => {
	const reg = await referenceRegistry();
	console.log("IndexDef", JSON.stringify(reg.bodyOf("orm.v1.IndexDef")?.fields.map(f=>[f.name,f.type,f.repeated,f.messageFqn,f.number])));
	console.log("ts", JSON.stringify(reg.importsOf("google/protobuf/timestamp.proto")));
	console.log("closure ts", JSON.stringify([...importClosure(reg, ["google/protobuf/timestamp.proto"]).paths], null, 0), importClosure(reg, ["google/protobuf/timestamp.proto"]).complete);
	console.log("closure orm", JSON.stringify([...importClosure(reg, ["orm/v1/annotations.proto"]).paths]), importClosure(reg, ["orm/v1/annotations.proto"]).complete);
	const d = reg.get("orm.v1.table");
	console.log("doc", JSON.stringify(d?.doc), JSON.stringify(d?.example));
});
