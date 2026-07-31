import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count >= 3 else {
    fputs("用法：vision_ocr image.png output.json [languages]\n", stderr)
    exit(2)
}

let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
let languages = CommandLine.arguments.count >= 4
    ? CommandLine.arguments[3].split(separator: ",").map(String.init)
    : ["zh-Hans", "en-US"]

guard
    let image = NSImage(contentsOf: imageURL),
    let data = image.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: data),
    let cgImage = bitmap.cgImage
else {
    fputs("无法载入图片\n", stderr)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = languages
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage)
try handler.perform([request])

let rows: [[String: Any]] = (request.results ?? []).compactMap { observation in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let box = observation.boundingBox
    return [
        "text": candidate.string,
        "confidence": candidate.confidence,
        "x": box.origin.x,
        "y": box.origin.y,
        "width": box.size.width,
        "height": box.size.height,
    ]
}

let json = try JSONSerialization.data(
    withJSONObject: rows,
    options: [.prettyPrinted, .sortedKeys]
)
try json.write(to: outputURL)
