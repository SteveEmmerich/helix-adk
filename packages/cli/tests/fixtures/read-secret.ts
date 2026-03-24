import { readSecret } from "../../src/bin/hlx.ts";

const value = await readSecret("Enter value: ");
console.log(value);
