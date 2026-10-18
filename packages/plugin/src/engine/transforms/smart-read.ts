import { smartCodeCollapse } from "./smart-code";
import { registerTransform } from "./registry";

registerTransform("smart-read", (lines) => smartCodeCollapse(lines));
