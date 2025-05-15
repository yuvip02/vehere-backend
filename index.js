import express from "express";
import cors from "cors";
import { NodeSSH } from "node-ssh";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import fs from "fs";
import { EventEmitter } from "events";
import { servicesServers } from "./components/servicesServers.js";
import PQueue from "p-queue";

EventEmitter.defaultMaxListeners = 100;

dotenv.config({ override: true });

const app = express();
app.use(cors());
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

process.on("unhandledRejection", (reason) => {
  console.error(" Unhandled Rejection:", reason);
  logError(`Unhandled Rejection: ${reason}`);
});
process.on("uncaughtException", (err) => {
  console.error(" Uncaught Exception:", err);
  logError(`Uncaught Exception: ${err.stack || err.message}`);
});

const sshUsername = process.env.SSH_USERNAME;
const sshPassword = process.env.SSH_PASSWORD;

const logstashUsername = process.env.LOGSTASH_USERNAME;
const logstashPassword = process.env.LOGSTASH_PASSWORD;

const logDirPath = process.env.LOG_DIR_PATH;

const sshInstances = [];
const probes = [];
const probeData = [];

const logstashInstances = [];
const logstashProbes = [];
const logstashData = [];

const servicesStatusData = [];
const servicesSSHInstances = {};

const retryCounter = {};
const retryTimestamp = {};

const globalQueue = new PQueue({
  concurrency: 10, 
  interval: 1000, 
  intervalCap: 10, 
});

const BANDWIDTH_THRESHOLD_KBPS = 1000;
const BANDWIDTH_TIMESTAMP_FILE = "./components/bandwidthTimestamps.json";
let bandwidthTimestamps = {};

try {
  const raw = fs.readFileSync(BANDWIDTH_TIMESTAMP_FILE, "utf-8");
  bandwidthTimestamps = JSON.parse(raw);
  console.log("✅ Loaded bandwidth timestamps");
} catch (err) {
  console.warn(
    " No previous bandwidth timestamp file found or invalid:",
    err.message
  );
  bandwidthTimestamps = {};
}

function saveBandwidthTimestamps() {
  fs.writeFileSync(
    BANDWIDTH_TIMESTAMP_FILE,
    JSON.stringify(bandwidthTimestamps, null, 2)
  );
}

const TIMESTAMP_FILE = "./components/downTimestamps.json";
let downTimestamps = {};

try {
  const raw = fs.readFileSync(TIMESTAMP_FILE, "utf-8");
  downTimestamps = JSON.parse(raw);
  console.log("✅ Loaded down timestamps");
} catch (err) {
  console.warn("⚠️ No previous timestamp file found or invalid:", err.message);
  downTimestamps = {};
}

function saveTimestampsToFile() {
  fs.writeFileSync(TIMESTAMP_FILE, JSON.stringify(downTimestamps, null, 2));
}

function logError(msg) {
  const formatted = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync("errorlogs.txt", formatted);
}

for (let i = 1; i <= 50; i++) {
  const host = process.env[`SSH_HOST${i}`];
  if (host && sshUsername && sshPassword) {
    probes.push({ host, username: sshUsername, password: sshPassword });
    probeData.push({
      ip: host,
      hostname: "Unknown",
      status: "Inactive",
      total: "0.00 Kbps",
      gbps_recv: "0 pps",
      recv_drop: "0 pps",
      sent: "0 pps",
      ports: ["-", "-", "-", "-"],
      services: { probe: "Inactive", recon: "Inactive" },
      fileCounts: {},
    });
    retryCounter[host] = 0;
    retryTimestamp[host] = 0;
  }
}

console.log("🔵 Total probes loaded:", probes.length);
probes.forEach((p, i) => console.log(` Probe ${i + 1}: ${p.host}`));

for (let i = 1; i <= 50; i++) {
  const host = process.env[`LOGSTASH_HOST${i}`];
  if (host && logstashUsername && logstashPassword) {
    logstashProbes.push({
      host,
      username: logstashUsername,
      password: logstashPassword,
    });
    logstashData.push({
      ip: host,
      hostname: "Logstash",
      status: "Inactive",
      fileCounts: {},
      isLogstash: true,
    });
  }
}

console.log("🟠 Total logstash loaded:", logstashProbes.length);
logstashProbes.forEach((p, i) => console.log(` Logstash ${i + 1}: ${p.host}`));

const monitorFixedServices = async (server) => {
  const { ip, services } = server;
  const ssh = new NodeSSH();
  servicesSSHInstances[ip] = ssh;

  try {
    console.log(`🔵 Connecting to fixed service server ${ip}...`);
    await ssh.connect({
      host: ip,
      username: sshUsername,
      password: sshPassword,
      keepaliveInterval: 10000,
      readyTimeout: 10000,
    });

    console.log(`✅ Connected to fixed service server ${ip}`);

    const hostnameResult = await ssh.execCommand("hostname");
    const resolvedHostname = hostnameResult.stdout?.trim() || "-";

    const result = await ssh.execCommand(
      services.map((s) => `systemctl is-active ${s}`).join(" && echo SPLIT && ")
    );

    const statuses = result.stdout
      .split("SPLIT")
      .flatMap((chunk) => chunk.trim().split("\n"));

    const statusMap = {};
    services.forEach((name, idx) => {
      statusMap[name] = statuses[idx] === "active" ? "active" : "inactive";
    });
    const anyServiceDown = Object.values(statusMap).some(
      (status) => status.toLowerCase() !== "active"
    );

    if (anyServiceDown) {
      if (!downTimestamps[ip]) {
        downTimestamps[ip] = new Date().toISOString();
        saveTimestampsToFile(); 
      }
    } else {
      if (downTimestamps[ip]) {
        delete downTimestamps[ip];
        saveTimestampsToFile(); 
      }
    }

    const index = servicesStatusData.findIndex((d) => d.ip === ip);
    if (index !== -1) {
      servicesStatusData[index].services = statusMap;
      servicesStatusData[index].hostname = resolvedHostname;
    } else {
      servicesStatusData.push({
        ip,
        hostname: resolvedHostname,
        services: statusMap,
        downSince: downTimestamps[ip] || null, // 
      });
    }

    io.emit("servicesStatus", [...servicesStatusData]);
  } catch (err) {
    const msg = `🔴 SSH failed for ${ip}: ${err.message}`;
    console.error(msg);
    logError(msg);

    const fallback = Object.fromEntries(services.map((s) => [s, "inactive"]));
    const index = servicesStatusData.findIndex((d) => d.ip === ip);
    if (index !== -1) {
      servicesStatusData[index].services = fallback;
    } else {
      servicesStatusData.push({ ip, hostname: "-", services: fallback });
    }

    io.emit("servicesStatus", servicesStatusData);
  }
};

const connectSSH = async (index) => {
  const ssh = new NodeSSH();
  sshInstances[index] = ssh;
  const host = probes[index].host;

  const now = Date.now();
  const delay = Math.min(60000, 5000 * retryCounter[host]);
  if (now - retryTimestamp[host] < delay) {
    return setTimeout(() => connectSSH(index), delay);
  }

  retryTimestamp[host] = now;

  try {
    console.log(`🔹 Connecting to SSH server ${host}...`);
    await ssh.connect({
      ...probes[index],
      keepaliveInterval: 10000,
      readyTimeout: 10000,
    });
    console.log(`SSH Connected to ${host}`);
    retryCounter[host] = 0;

    const hostname = await executeSSHCommand(index, "hostname");
    probeData[index].hostname = hostname || "Unknown";

    monitorLogs(index);
    fetchFileCounts(index);
    setInterval(() => updateServiceStatus(index), 10000);

    ssh.connection.on("close", () => reconnectSSH(index));
    ssh.connection.on("error", () => reconnectSSH(index));
  } catch (err) {
    const msg = ` SSH Connection Failed for ${host}: ${err.message}`;
    console.error(msg);
    logError(msg);

    if (++retryCounter[host] <= 5) {
      setTimeout(() => connectSSH(index), 5000);
    } else {
      logError(` Too many retries for ${host}, skipping for now.`);
    }
  }
};

const reconnectSSH = (index) => {
  const host = probes[index].host;
  logError(` SSH Disconnected from ${host}. Reconnecting...`);
  setTimeout(() => connectSSH(index), 5000);
};

const executeSSHCommand = async (index, command) => {
  const host = probes[index].host;
  try {
    if (!sshInstances[index]?.isConnected()) await connectSSH(index);
    const result = await sshInstances[index].execCommand(command);
    if (result.stderr) {
      logError(` SSH stderr on ${host}: ${result.stderr}`);
      return null;
    }
    return result.stdout.trim();
  } catch (err) {
    logError(` SSH Command Error on ${host}: ${err.message}`);
    reconnectSSH(index);
    return null;
  }
};

const fetchFileCounts = async (index) => {
  const host = probes[index].host;
  try {
    const fileExists = await executeSSHCommand(
      index,
      "[ -f /opt/filecount.sh ] && echo FOUND || echo NOT_FOUND"
    );
    if (fileExists !== "FOUND") {
      logError(` /opt/filecount.sh not found on ${host}`);
      return;
    }

    await new Promise((resolve) => {
      sshInstances[index].exec("/opt/filecount.sh", [], {
        onStdout(chunk) {
          const fileCounts = {};
          chunk
            .toString()
            .split("\n")
            .forEach((line) => {
              const match = line.match(/File count at (\w+): (\d+)/);
              if (match) fileCounts[match[1]] = parseInt(match[2], 10);
            });
          probeData[index].fileCounts = fileCounts;
          io.emit("probeData", [...probeData, ...logstashData]);
        },
        onClose: resolve,
        onError: resolve,
        onStderr(chunk) {
          logError(` File Count Error on ${host}: ${chunk.toString()}`);
          resolve();
        },
      });
    });
  } catch (err) {
    logError(` fetchFileCounts crashed on ${host}: ${err.message}`);
  }
};

const monitorLogs = async (index) => {
  const host = probes[index].host;
  try {
    await executeSSHCommand(index, `pkill -f "tail -f ${logDirPath}"`);
    const latestLog = await executeSSHCommand(
      index,
      `ls -t ${logDirPath} | head -n 1`
    );
    if (!latestLog) return;

    sshInstances[index].exec(`tail -f ${logDirPath}/${latestLog}`, [], {
      onStdout(chunk) {
        chunk
          .toString()
          .split("\n")
          .forEach((line) => parseLogLine(index, line));
      },
      onStderr(chunk) {
        logError(` Log Error on ${host}: ${chunk.toString()}`);
      },
    });
  } catch (err) {
    logError(` Log Monitor Error (${host}): ${err.message}`);
  }
};
const parseLogLine = (index, line) => {
  if (!line.trim()) return;

  const bandwidthRegex =
    /Bandwidth\s+([\d'.,]+)\s*\(\s*([\d'.,]+)?[,]?\s*([\d'.,]*)?[,]?\s*([\d'.,]*)?[,]?\s*([\d'.,]*)?\)\s*Kbps/;
  const receivedRegex = /Received\s+(\d+)\s+\(/;
  const droppedRegex = /Dropped\s+(\d+)\s+\(/;
  const sentRegex = /Sent\s+(\d+)\s+\(/;

  const host = probes[index].host;

  if (bandwidthRegex.test(line)) {
    const match = line.match(bandwidthRegex);
    const total = parseFloat(match[1].replace(/'/g, "")).toFixed(2);
    const ports = [match[2], match[3], match[4], match[5]].map((v) =>
      v ? `${parseFloat(v.replace(/'/g, "")).toFixed(2)} Kbps` : "-"
    );
    probeData[index].total = `${total} Kbps`;
    probeData[index].ports = ports;

   
    if (total < BANDWIDTH_THRESHOLD_KBPS) {
 
      if (!bandwidthTimestamps[host]) {
        bandwidthTimestamps[host] = new Date().toLocaleString("en-IN");
        saveBandwidthTimestamps();
      }
    } else {
    
      if (bandwidthTimestamps[host]) {
        delete bandwidthTimestamps[host];
        saveBandwidthTimestamps();
      }
    }

    probeData[index].bandwidthTimestamp = bandwidthTimestamps[host] || null;
  }

  if (receivedRegex.test(line)) {
    const match = line.match(receivedRegex);
    probeData[index].gbps_recv = match[1] + " pps";
  }

  if (droppedRegex.test(line)) {
    const match = line.match(droppedRegex);
    probeData[index].recv_drop = match[1] + " pps";
  }

  if (sentRegex.test(line)) {
    const match = line.match(sentRegex);
    probeData[index].sent = match[1] + " pps";
  }

  probeData[index].status = "Active";

  io.emit("probeData", [...probeData, ...logstashData]);
};

const updateServiceStatus = async (index) => {
  const host = probes[index].host;
  const ping = await executeSSHCommand(
    index,
    `ping -c 1 ${host} > /dev/null && echo Active || echo Inactive`
  );
  probeData[index].status = ping || "Inactive";

  if (ping === "Active") {
    const output = await executeSSHCommand(
      index,
      `systemctl is-active probe && systemctl is-active recon`
    );
    const [probeStatus, reconStatus] = output
      ? output.split("\n")
      : ["Inactive", "Inactive"];
    probeData[index].services.probe =
      probeStatus === "active" ? "Active" : "Inactive";
    probeData[index].services.recon =
      reconStatus === "active" ? "Active" : "Inactive";
  } else {
    probeData[index].services.probe = "Inactive";
    probeData[index].services.recon = "Inactive";
  }

  io.emit("probeData", [...probeData, ...logstashData]);
};

const connectLogstash = async (index) => {
  const ssh = new NodeSSH();
  logstashInstances[index] = ssh;
  const host = logstashProbes[index].host;

  try {
    console.log(` Connecting to Logstash server ${host}...`);
    await ssh.connect({
      ...logstashProbes[index],
      keepaliveInterval: 10000,
      readyTimeout: 10000,
    });
    console.log(` SSH Connected to Logstash ${host}`);

    const hostnameResult = await ssh.execCommand("hostname");
    if (hostnameResult.stdout) {
      logstashData[index].hostname = hostnameResult.stdout.trim();
    }

    setInterval(async () => {
      try {
        const statusResult = await ssh.execCommand(
          "systemctl is-active logstash"
        );

        if (statusResult.stderr && statusResult.stderr.trim() !== "") {
          logstashData[index].logstashServiceStatus = "-";
          logError(
            `Logstash periodic check stderr on ${host}: ${statusResult.stderr.trim()}`
          );
        } else {
          const rawStatus = statusResult.stdout.trim();
          logstashData[index].logstashServiceStatus =
            rawStatus === "active" ? "Active" : "Inactive";
        }

        io.emit("probeData", [...probeData, ...logstashData]);
      } catch (err) {
        logstashData[index].logstashServiceStatus = "-";
        logError(
          `Periodic logstash status check failed on ${host}: ${err.message}`
        );
      }
    }, 60000);

    try {
      const statusResult = await ssh.execCommand(
        "systemctl is-active logstash"
      );

      if (statusResult.stderr && statusResult.stderr.trim() !== "") {
        logstashData[index].logstashServiceStatus = "-";
        logError(
          `Logstash status stderr on ${host}: ${statusResult.stderr.trim()}`
        );
      } else {
        const rawStatus = statusResult.stdout.trim();
        logstashData[index].logstashServiceStatus =
          rawStatus === "active" ? "Active" : "Inactive";
      }
    } catch (err) {
      logstashData[index].logstashServiceStatus = "-";
      logError(`Failed to check logstash status on ${host}: ${err.message}`);
    }

    await new Promise((resolve) => {
      ssh.exec("/opt/filecount.sh", [], {
        onStdout(chunk) {
          const fileCounts = {};
          chunk
            .toString()
            .split("\n")
            .forEach((line) => {
              const match = line.match(/File count at (\w+): (\d+)/);
              if (match) fileCounts[match[1]] = parseInt(match[2], 10);
            });
          logstashData[index].fileCounts = fileCounts;
          logstashData[index].status = "Active";
          io.emit("probeData", [...probeData, ...logstashData]);
        },
        onClose: resolve,
        onError: resolve,
        onStderr(chunk) {
          logError(`File Count Error on Logstash ${host}: ${chunk.toString()}`);
          resolve();
        },
      });
    });
  } catch (err) {
    console.error(
      ` SSH Logstash connection failed for ${host}: ${err.message}`
    );
    logError(` SSH Logstash connection failed for ${host}: ${err.message}`);
  }
};

app.get("/api/log-data", (req, res) =>
  res.json([...probeData, ...logstashData])
);

const PORT = 3000;
io.on("connection", (socket) => {
  console.log("📡 New client connected");
  socket.emit("servicesStatus", [...servicesStatusData]);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);

  probes.forEach((_, index) => {
    globalQueue.add(() => connectSSH(index));
  });

  logstashProbes.forEach((_, index) => {
    globalQueue.add(() => connectLogstash(index));
  });

  io.emit("servicesStatus", servicesStatusData);

  const SERVICE_REFRESH_INTERVAL = 60 * 1000;

  const runInitialServiceChecks = async () => {
    for (const server of servicesServers) {
      await globalQueue
        .add(() => monitorFixedServices(server))
        .catch((err) => {
          logError(`Initial queue failed for ${server.ip}: ${err.message}`);
        });
    }
  };

  const scheduleServiceChecks = () => {
    servicesServers.forEach((server) => {
      globalQueue
        .add(() => monitorFixedServices(server))
        .catch((err) => {
          logError(`Periodic queue failed for ${server.ip}: ${err.message}`);
        });
    });
    setTimeout(scheduleServiceChecks, SERVICE_REFRESH_INTERVAL);
  };

  runInitialServiceChecks().then(() => {
    io.emit("servicesStatus", servicesStatusData);
    scheduleServiceChecks();
  });
  const runInitialLogstashChecks = async () => {
    for (const [index, _] of logstashProbes.entries()) {
      globalQueue.add(() => connectLogstash(index));
    }
  };
  runInitialLogstashChecks().then(() => {
    io.emit("probeData", [...probeData, ...logstashData]);
  });
});
