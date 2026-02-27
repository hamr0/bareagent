# bareagent Ruby wrapper -- subprocess + JSONL over stdin/stdout.
# stdlib only: open3, json.

require "open3"
require "json"

class BareAgent
  attr_writer :on_event

  # Spawn a bareagent subprocess.
  #   BareAgent.new(provider: "openai", model: "gpt-4o-mini")
  def initialize(provider: "openai", model: nil, url: nil)
    cmd = ["npx", "bareagent", "--jsonl", "--provider", provider]
    cmd += ["--model", model] if model
    cmd += ["--url", url] if url
    @stdin, @stdout, @stderr, @wait_thr = Open3.popen3(*cmd)
    @on_event = nil
  end

  # Send a goal string or messages array, block until result.
  def run(goal_or_messages)
    params = if goal_or_messages.is_a?(String)
               { "goal" => goal_or_messages }
             else
               { "messages" => goal_or_messages }
             end

    req = JSON.generate({ "method" => "run", "params" => params })
    @stdin.puts(req)
    @stdin.flush

    @stdout.each_line do |line|
      line = line.strip
      next if line.empty?
      event = JSON.parse(line)
      if @on_event && !%w[result error].include?(event["type"])
        @on_event.call(event)
      end
      return event["data"] if %w[result error].include?(event["type"])
    end
    nil
  end

  # Terminate the subprocess.
  def close
    @stdin.close unless @stdin.closed?
    @wait_thr.join
  end
end

if __FILE__ == $PROGRAM_NAME
  agent = BareAgent.new(provider: "openai", model: "gpt-4o-mini")
  puts "Spawned bareagent subprocess"
  result = agent.run("What is 2 + 2?")
  if result
    puts "Result: #{result['text'] || result}"
  else
    puts "No result received"
  end
  agent.close
  puts "Done"
end
