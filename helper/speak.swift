// read-aloud WAV player, for the command engine (Piper, Kokoro, ...):
//
//   speak wav <file>   play the WAV; stdin is its text, for word timing
//
// Prints `W <utf16 offset> <utf16 length>` as each word starts, then `E`.
// The system engine needs none of this: `say` reports its own words.
import AVFoundation
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
func emit(_ line: String) { print(line); fflush(stdout) }

let args = CommandLine.arguments
guard args.count > 2, args[1] == "wav",
      let player = try? AVAudioPlayer(contentsOf: URL(fileURLWithPath: args[2])) else {
    FileHandle.standardError.write("usage: speak wav <file> (and the file must play)\n".data(using: .utf8)!)
    exit(1)
}
let text = (String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "") as NSString
// ponytail: a plain WAV has no word timings, so spread the words over the
// clip by length. Kokoro's own timestamps would be exact; add when needed.
let words = try! NSRegularExpression(pattern: "\\S+")
    .matches(in: text as String, range: NSRange(location: 0, length: text.length)).map(\.range)
let total = Double(max(1, words.reduce(0) { $0 + $1.length + 1 }))
var at = 0.0
let start = Date()
player.play()
for w in words {
    let wait = at * player.duration / total - Date().timeIntervalSince(start)
    if wait > 0 { Thread.sleep(forTimeInterval: wait) }
    emit("W \(w.location) \(w.length)")
    at += Double(w.length + 1)
}
while player.isPlaying { Thread.sleep(forTimeInterval: 0.05) }
emit("E")
