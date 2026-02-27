import java.io.*;
import java.util.*;

/**
 * bare-agent Java wrapper -- subprocess + JSONL over stdin/stdout.
 * stdlib only: ProcessBuilder, simple JSON parsing (no javax.json needed).
 *
 * Usage:
 *   BareAgent agent = new BareAgent("openai", "gpt-4o-mini", null);
 *   Map<String, Object> result = agent.run("What is 2 + 2?");
 *   System.out.println(result.get("text"));
 *   agent.close();
 */
public class BareAgent {

    private final Process process;
    private final BufferedWriter stdin;
    private final BufferedReader stdout;
    private EventCallback onEvent;

    @FunctionalInterface
    public interface EventCallback {
        void onEvent(String type, String rawJson);
    }

    public BareAgent(String provider, String model, String url) throws IOException {
        List<String> cmd = new ArrayList<>(Arrays.asList(
            "npx", "bare-agent", "--jsonl", "--provider", provider
        ));
        if (model != null) { cmd.add("--model"); cmd.add(model); }
        if (url != null) { cmd.add("--url"); cmd.add(url); }

        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(false);
        pb.environment().putAll(System.getenv());
        this.process = pb.start();
        this.stdin = new BufferedWriter(new OutputStreamWriter(process.getOutputStream()));
        this.stdout = new BufferedReader(new InputStreamReader(process.getInputStream()));
    }

    public void setOnEvent(EventCallback callback) {
        this.onEvent = callback;
    }

    /** Send a goal string and block until result. */
    public String run(String goal) throws IOException {
        String req = "{\"method\":\"run\",\"params\":{\"goal\":" + jsonEscape(goal) + "}}";
        stdin.write(req);
        stdin.newLine();
        stdin.flush();
        return readUntilTerminal();
    }

    /** Send a pre-built JSON params string and block until result. */
    public String runRaw(String paramsJson) throws IOException {
        String req = "{\"method\":\"run\",\"params\":" + paramsJson + "}";
        stdin.write(req);
        stdin.newLine();
        stdin.flush();
        return readUntilTerminal();
    }

    private String readUntilTerminal() throws IOException {
        String line;
        while ((line = stdout.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty()) continue;
            String type = extractType(line);
            if (type != null && !type.equals("result") && !type.equals("error")) {
                if (onEvent != null) onEvent.onEvent(type, line);
                continue;
            }
            if ("result".equals(type) || "error".equals(type)) {
                return extractData(line);
            }
        }
        return null;
    }

    /** Terminate the subprocess. */
    public void close() {
        try { stdin.close(); } catch (IOException ignored) {}
        try { process.waitFor(); } catch (InterruptedException ignored) {}
    }

    // Minimal JSON helpers -- avoids external deps.

    private static String jsonEscape(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:   sb.append(c);
            }
        }
        return sb.append("\"").toString();
    }

    private static String extractType(String json) {
        int i = json.indexOf("\"type\"");
        if (i < 0) return null;
        int colon = json.indexOf(':', i + 6);
        if (colon < 0) return null;
        int q1 = json.indexOf('"', colon + 1);
        if (q1 < 0) return null;
        int q2 = json.indexOf('"', q1 + 1);
        if (q2 < 0) return null;
        return json.substring(q1 + 1, q2);
    }

    private static String extractData(String json) {
        int i = json.indexOf("\"data\"");
        if (i < 0) return json;
        int colon = json.indexOf(':', i + 6);
        if (colon < 0) return json;
        // Return everything from after the colon to before the last }
        // This is a rough extraction -- for production use, add a JSON library
        int start = colon + 1;
        while (start < json.length() && json.charAt(start) == ' ') start++;
        int end = json.lastIndexOf('}');
        if (end <= start) return json;
        return json.substring(start, end);
    }

    public static void main(String[] args) throws Exception {
        BareAgent agent = new BareAgent("openai", "gpt-4o-mini", null);
        System.out.println("Spawned bare-agent subprocess");
        agent.setOnEvent((type, raw) ->
            System.out.printf("[%s] %s%n", type, raw)
        );
        String result = agent.run("What is 2 + 2?");
        System.out.println("Result: " + result);
        agent.close();
        System.out.println("Done");
    }
}
