import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import nodemailer from "nodemailer";

import { buildSmtpTransportOptions } from "./smtpTransport";
import { classifyReminderFailure } from "./reminderDispatch";

// 本地起一个极简 SMTP 服务，按面板的传输参数真发一封：守住 nodemailer 升级后
// 发信流程、以及提醒分发依赖的错误字段（code / command / responseCode）没变。

const REJECTED = "nobody@blocked.test";

async function startFakeSmtp() {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let data = "";
    socket.write("220 fake.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(data);
            data = "";
            socket.write("250 2.0.0 queued as fake-1\r\n");
          } else {
            data += `${line}\n`;
          }
          continue;
        }
        const command = line.toUpperCase();
        if (command.startsWith("EHLO") || command.startsWith("HELO")) socket.write("250-fake.test\r\n250 8BITMIME\r\n");
        else if (command.startsWith("MAIL FROM")) socket.write("250 2.1.0 ok\r\n");
        else if (command.startsWith("RCPT TO")) socket.write(line.includes(REJECTED) ? "550 5.1.1 no such user\r\n" : "250 2.1.5 ok\r\n");
        else if (command === "DATA") { inData = true; socket.write("354 go ahead\r\n"); }
        else if (command === "RSET") socket.write("250 2.0.0 ok\r\n");
        else if (command === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write("502 5.5.2 not implemented\r\n");
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, messages, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("nodemailer sends through the panel's SMTP options and keeps the error fields reminders rely on", async () => {
  const smtp = await startFakeSmtp();
  try {
    const transporter = nodemailer.createTransport(buildSmtpTransportOptions({ host: "127.0.0.1", port: smtp.port, security: "none" }));
    try {
      const sent = await transporter.sendMail({ from: "panel@fake.test", to: "user@fake.test", subject: "NEX 验证码", text: "123456" });
      assert.ok(sent.messageId);
      assert.equal(smtp.messages.length, 1);
      assert.match(smtp.messages[0], /123456/);

      const rejected = await transporter.sendMail({ from: "panel@fake.test", to: REJECTED, subject: "x", text: "x" })
        .then(() => null, (error) => error);
      assert.ok(rejected, "收件人被拒要报错");
      assert.equal(rejected.code, "EENVELOPE");
      assert.equal(rejected.responseCode, 550);
      assert.match(String(rejected.command), /^RCPT/);
      assert.equal(classifyReminderFailure(rejected), "recipient");

      const noRecipient = await transporter.sendMail({ from: "panel@fake.test", to: "not-an-address", subject: "x", text: "x" })
        .then(() => null, (error) => error);
      assert.ok(noRecipient, "收件地址解析不出来要报错");
      assert.equal(classifyReminderFailure(noRecipient), "recipient");
    } finally {
      transporter.close();
    }
  } finally {
    await smtp.close();
  }
});

test("a refused SMTP connection is a transport failure, not a bad recipient", async () => {
  const smtp = await startFakeSmtp();
  const port = smtp.port;
  await smtp.close();
  const transporter = nodemailer.createTransport(buildSmtpTransportOptions({ host: "127.0.0.1", port, security: "none" }));
  try {
    const error = await transporter.sendMail({ from: "panel@fake.test", to: "user@fake.test", subject: "x", text: "x" })
      .then(() => null, (failure) => failure);
    assert.ok(error);
    assert.ok(["ECONNECTION", "ECONNREFUSED", "ESOCKET"].includes(String(error.code)), `code=${String(error.code)}`);
    assert.equal(classifyReminderFailure(error), "transport");
  } finally {
    transporter.close();
  }
});
