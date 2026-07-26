import { evaluateProvenancePolicy } from "./provenance-policy-eval.js";

process.stdout.write(`${JSON.stringify(evaluateProvenancePolicy())}\n`);
