import Foundation
import UIKit
import os.log

public protocol Greetable {
    var name: String { get }
    var nickname: String? { get set }
    func greet() -> String
    func farewell(times: Int) async throws -> [String]
}

public protocol Identifiable: AnyObject {
    var id: Int { get }
}

public class Person: Greetable, Identifiable {
    public var name: String
    public var nickname: String?
    public let id: Int
    private var nicknames: [String] = []
    public var pet: Animal?
    public var lookup: [String: Person]
    internal static var counter: Int = 0

    public init(name: String, id: Int) {
        self.name = name
        self.id = id
        self.lookup = [:]
    }

    public func greet() -> String { return "hi" }
    public func farewell(times: Int) async throws -> [String] { return [] }
    public override func description() -> String { return name }
}

public struct Point {
    let x: Int
    let y: Int
}

public enum Direction {
    case north
    case south
    case east(speed: Int)
    case west(speed: Int, weight: Double)
}

extension Person: Equatable {
    public func shout() -> String { return name }
}

public typealias UserID = Int
public typealias Callback = (Int) -> Void

public class Animal {}

public func freeFunc(_ x: Int) -> Int { return x }

let GLOBAL: String = "hi"
var counter: Int = 0
