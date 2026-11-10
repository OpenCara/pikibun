import { host, mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { mkdir, readdir, rmdir, unlink, writeFile } from "fs/promises";
import { Composer } from "../../src/components/Composer";
import { createAttachments, decodeBase64 } from "../../src/lib/attachments";

const folder = String((host.params as { folder?: unknown }).folder ?? "");
const dot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

mount(() => {
  const attachments = createAttachments({ imagesUnavailable: () => undefined, fileOptions: () => ({ maxBytes: 1024 }) });
  const staged = signal(false);
  const problem = signal("");
  void (async () => {
    await mkdir(folder, { recursive: true });
    await writeFile(`${folder}/notes.txt`, "hello\n");
    await writeFile(`${folder}/dot.png`, decodeBase64(dot));
    await writeFile(`${folder}/large.txt`, "x".repeat(2048));
    staged.set(true);
  })().catch(reason => problem.set(`Couldn't put the test's files in ${folder}: ${String(reason)}`));
  const clean = async () => {
    for (const name of await readdir(folder)) await unlink(`${folder}/${name}`);
    await rmdir(folder);
  };
  return (
    <View style={{ padding: 16, gap: 8 }}>
      <Composer value="" onChange={() => undefined} onSubmit={() => undefined} busy={false} placeholder="Message" sendLabel="Send" hint="" attachments={attachments} />
      <If when={problem()}><Text>{problem()}</Text></If>
      <If when={staged()}><Button testID="clean-up" onPress={() => void clean().then(() => staged.set(false))}><Text>Clean up</Text></Button></If>
    </View>
  );
});
