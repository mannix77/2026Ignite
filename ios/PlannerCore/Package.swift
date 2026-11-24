// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PlannerCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "PlannerCore", targets: ["PlannerCore"])],
    targets: [
        .target(name: "PlannerCore"),
        .testTarget(name: "PlannerCoreTests", dependencies: ["PlannerCore"], resources: [.copy("Fixtures")]),
    ]
)
