export async function createFileLogger(path: string) {
    const handle = await tjs.open(path, "a");

    return (formattedLog: string) => {
        try {
            const data = new TextEncoder().encode(`${formattedLog}\n`);
            handle.write(data).catch(err => console.error(`Failed to write to log file: ${err}`));
        } catch (error) {
            console.error(`Failed to write to log file: ${error}`);
        }
    };
}
