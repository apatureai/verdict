// Regenerate the cross-repo calibration contract (sigil#2):
//   pnpm --filter @apatureai/verdict-eval gen:calibration-contract
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderCalibrationContract } from "../dist/calibration-contract.js";

const out = fileURLToPath(new URL("../fixtures/calibration-contract.golden.json", import.meta.url));
writeFileSync(out, renderCalibrationContract());
console.log(`wrote ${out}`);
