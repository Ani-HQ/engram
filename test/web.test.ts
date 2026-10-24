import { isolatedSuite } from "./isolated-suite";

isolatedSuite("web behavior with isolated module mocks", new URL("./isolated/web.suite.ts", import.meta.url));
