import { Seconds, Time, Timestamp } from "@matter/general";

Time.startup.processMs = Timestamp(Time.nowMs - Seconds(performance.now()));
Time.startup.systemMs = Timestamp(Time.nowMs - Seconds(tjs.system.uptime));
