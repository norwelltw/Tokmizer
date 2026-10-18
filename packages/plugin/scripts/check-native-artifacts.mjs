import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativePlatforms, verifyNativeArtifacts, verifySingleArtifacts } from "./native-artifacts.mjs";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
verifyNativeArtifacts(directory);
verifySingleArtifacts(directory);
console.log(`native release artifacts verified: ${nativePlatforms.join(", ")}`);
