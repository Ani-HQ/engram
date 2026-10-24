import { isolatedSuite } from "./isolated-suite";

isolatedSuite("verbs behavior with isolated module mocks", new URL("./isolated/verbs.suite.ts", import.meta.url));
