import { isolatedSuite } from "./isolated-suite";

isolatedSuite("Jev consent, transport and metering boundary", new URL("./isolated/jev-provider.suite.ts", import.meta.url));
