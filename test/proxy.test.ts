import { isolatedSuite } from "./isolated-suite";

isolatedSuite("proxy behavior with isolated module mocks", new URL("./isolated/proxy.suite.ts", import.meta.url));
