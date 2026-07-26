import CoreGraphics
import Foundation
import ImageIO
import Vision

struct VisionOutput: Codable {
  let text: [String]
  let labels: [String]
}

func emit(_ output: VisionOutput) {
  let encoder = JSONEncoder()
  guard let data = try? encoder.encode(output),
        let json = String(data: data, encoding: .utf8) else {
    print("{\"text\":[],\"labels\":[]}")
    return
  }
  print(json)
}

guard CommandLine.arguments.count == 2 else {
  emit(VisionOutput(text: [], labels: []))
  exit(2)
}

let imageUrl = URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL
guard let source = CGImageSourceCreateWithURL(imageUrl, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  emit(VisionOutput(text: [], labels: []))
  exit(3)
}

let textRequest = VNRecognizeTextRequest()
textRequest.recognitionLevel = .accurate
textRequest.usesLanguageCorrection = true
let preferredLanguages = ["ru-RU", "kk-KZ", "en-US"]
if let supported = try? textRequest.supportedRecognitionLanguages() {
  let selected = preferredLanguages.filter { supported.contains($0) }
  if !selected.isEmpty { textRequest.recognitionLanguages = selected }
}

let classifyRequest = VNClassifyImageRequest()
let handler = VNImageRequestHandler(cgImage: image, options: [:])

do {
  try handler.perform([textRequest, classifyRequest])
} catch {
  emit(VisionOutput(text: [], labels: []))
  exit(4)
}

var recognizedText: [String] = []
for observation in (textRequest.results ?? []).prefix(80) {
  guard let candidate = observation.topCandidates(1).first else { continue }
  let value = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
  if !value.isEmpty && !recognizedText.contains(value) {
    recognizedText.append(value)
  }
}

var labels: [String] = []
for observation in (classifyRequest.results ?? []) {
  if observation.confidence < 0.20 { continue }
  let value = observation.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
  if !value.isEmpty && !labels.contains(value) { labels.append(value) }
  if labels.count >= 8 { break }
}

emit(VisionOutput(text: recognizedText, labels: labels))
