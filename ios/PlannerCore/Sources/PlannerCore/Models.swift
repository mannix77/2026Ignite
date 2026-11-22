import Foundation

/// The one definition of a usable identifier: a string that is not blank once trimmed.
/// Everything downstream uses the cleaned value.
public enum Identifier {
    public static func clean(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}

/// When a session runs, as wall-clock time in the event's own time zone.
public struct SessionTime: Codable, Equatable, Sendable {
    public var date: String
    public var time: String
    /// Minutes. The API sends this as a string ("60"); a number is accepted too.
    public var length: String?
    public var timezone: String?

    public init(date: String, time: String, length: String? = nil, timezone: String? = nil) {
        self.date = date
        self.time = time
        self.length = length
        self.timezone = timezone
    }

    private enum CodingKeys: String, CodingKey { case date, time, length, timezone }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = try c.decode(String.self, forKey: .date)
        time = try c.decode(String.self, forKey: .time)
        timezone = try? c.decodeIfPresent(String.self, forKey: .timezone)
        if let text = try? c.decodeIfPresent(String.self, forKey: .length) {
            length = text
        } else if let number = try? c.decodeIfPresent(Double.self, forKey: .length) {
            length = String(Int(number))
        } else {
            length = nil
        }
    }

    /// Minutes after midnight, or nil when `time` is not "HH:MM" within a day.
    public var startMinute: Int? {
        let parts = time.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]),
              (0...23).contains(h), (0...59).contains(m) else { return nil }
        return h * 60 + m
    }

    /// Length in minutes; 0 when missing, negative or not a number.
    public var lengthMinutes: Int {
        guard let length, let n = Int(length.trimmingCharacters(in: .whitespaces)), n > 0 else { return 0 }
        return n
    }

    /// True when `date` is "YYYY-MM-DD".
    public var hasValidDate: Bool {
        let parts = date.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              Int(parts[0]) != nil, let m = Int(parts[1]), let d = Int(parts[2]) else { return false }
        return (1...12).contains(m) && (1...31).contains(d)
    }
}

public struct Speaker: Codable, Equatable, Sendable {
    public var name: String?
    public init(name: String?) { self.name = name }
}

/// One session. Only `sessionId` and `title` are guaranteed by the API.
public struct Session: Codable, Equatable, Identifiable, Sendable {
    public var sessionId: String
    public var title: String
    public var abbreviation: String?
    public var abstract: String?
    public var type: String?
    public var level: String?
    public var venue: String?
    public var room: String?
    public var isAllDaySession: Bool?
    public var isReservable: Bool?
    public var seatAvailability: String?
    public var sessionTime: SessionTime?
    public var speakers: [Speaker]?
    public var topics: [String]?
    public var areasOfInterest: [String]?
    public var roles: [String]?
    public var services: [String]?
    public var industries: [String]?
    public var features: [String]?

    public var id: String { sessionId }

    public init(sessionId: String, title: String, abbreviation: String? = nil, abstract: String? = nil,
                type: String? = nil, level: String? = nil, venue: String? = nil, room: String? = nil,
                isAllDaySession: Bool? = nil, isReservable: Bool? = nil, seatAvailability: String? = nil,
                sessionTime: SessionTime? = nil, speakers: [Speaker]? = nil, topics: [String]? = nil,
                areasOfInterest: [String]? = nil, roles: [String]? = nil, services: [String]? = nil,
                industries: [String]? = nil, features: [String]? = nil) {
        self.sessionId = sessionId
        self.title = title
        self.abbreviation = abbreviation
        self.abstract = abstract
        self.type = type
        self.level = level
        self.venue = venue
        self.room = room
        self.isAllDaySession = isAllDaySession
        self.isReservable = isReservable
        self.seatAvailability = seatAvailability
        self.sessionTime = sessionTime
        self.speakers = speakers
        self.topics = topics
        self.areasOfInterest = areasOfInterest
        self.roles = roles
        self.services = services
        self.industries = industries
        self.features = features
    }

    private enum CodingKeys: String, CodingKey {
        case sessionId, title, abbreviation, abstract, type, level, venue, room, isAllDaySession,
             isReservable, seatAvailability, sessionTime, speakers, topics, areasOfInterest, roles,
             services, industries, features
    }

    /// A session without a usable id or title is refused; every other field is best effort, so
    /// one odd field never costs the whole session.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = Identifier.clean(try? c.decode(String.self, forKey: .sessionId)) else {
            throw DecodingError.dataCorruptedError(forKey: .sessionId, in: c, debugDescription: "no usable session id")
        }
        guard let title = Identifier.clean(try? c.decode(String.self, forKey: .title)) else {
            throw DecodingError.dataCorruptedError(forKey: .title, in: c, debugDescription: "no usable title")
        }
        sessionId = id
        self.title = title
        func text(_ key: CodingKeys) -> String? { Identifier.clean(try? c.decodeIfPresent(String.self, forKey: key)) }
        func list(_ key: CodingKeys) -> [String]? { try? c.decodeIfPresent([String].self, forKey: key) }
        abbreviation = text(.abbreviation)
        abstract = text(.abstract)
        type = text(.type)
        level = text(.level)
        venue = text(.venue)
        room = text(.room)
        seatAvailability = text(.seatAvailability)
        isAllDaySession = try? c.decodeIfPresent(Bool.self, forKey: .isAllDaySession)
        isReservable = try? c.decodeIfPresent(Bool.self, forKey: .isReservable)
        sessionTime = try? c.decodeIfPresent(SessionTime.self, forKey: .sessionTime)
        speakers = try? c.decodeIfPresent([Speaker].self, forKey: .speakers)
        topics = list(.topics)
        areasOfInterest = list(.areasOfInterest)
        roles = list(.roles)
        services = list(.services)
        industries = list(.industries)
        features = list(.features)
    }

    /// The short public code ("AIM320-R1"), or the title when the session has none.
    public var code: String { abbreviation ?? title }

    public var speakerNames: [String] { (speakers ?? []).compactMap { Identifier.clean($0.name) } }
}

/// Decodes to nil instead of failing, so one bad record cannot sink a list.
struct Lossy<Value: Decodable>: Decodable {
    let value: Value?
    init(from decoder: Decoder) throws { value = try? Value(from: decoder) }
}

/// One page of `ListSessions`.
public struct SessionsPage: Decodable, Sendable {
    public var items: [Session]
    /// Records that had no usable id or title.
    public var skipped: Int
    public var totalCount: Int
    public var nextToken: String?

    private enum CodingKeys: String, CodingKey { case items, totalCount, nextToken }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try c.decode([Lossy<Session>].self, forKey: .items)
        items = raw.compactMap(\.value)
        skipped = raw.count - items.count
        let total = try c.decode(Double.self, forKey: .totalCount)
        guard total.isFinite, total >= 0, total == total.rounded() else {
            throw DecodingError.dataCorruptedError(forKey: .totalCount, in: c, debugDescription: "not a count")
        }
        totalCount = Int(total)
        nextToken = Identifier.clean(try? c.decodeIfPresent(String.self, forKey: .nextToken))
    }
}

public struct PersonalTime: Codable, Equatable, Sendable {
    public var personalTimeId: String
    public var title: String
    public var description: String?
    public var location: String?
    public var startDateTime: String
    public var endDateTime: String
}

/// What the conference site holds for one attendee.
public struct Schedule: Codable, Equatable, Sendable {
    public var reserved: [String]
    public var favorites: [String]
    public var invitedSessions: [Session]
    public var personalTime: [PersonalTime]

    public init(reserved: [String] = [], favorites: [String] = [], invitedSessions: [Session] = [],
                personalTime: [PersonalTime] = []) {
        self.reserved = reserved
        self.favorites = favorites
        self.invitedSessions = invitedSessions
        self.personalTime = personalTime
    }

    private enum CodingKeys: String, CodingKey { case reserved, favorites, invitedSessions, personalTime }

    /// `reserved` and `favorites` are required: a schedule without them is not a schedule, and
    /// reading it as "nothing reserved" would wipe a good calendar.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reserved = try c.decode([Lossy<String>].self, forKey: .reserved).compactMap { Identifier.clean($0.value) }
        favorites = try c.decode([Lossy<String>].self, forKey: .favorites).compactMap { Identifier.clean($0.value) }
        invitedSessions = ((try? c.decodeIfPresent([Lossy<Session>].self, forKey: .invitedSessions)) ?? [])
            .compactMap(\.value)
        personalTime = ((try? c.decodeIfPresent([Lossy<PersonalTime>].self, forKey: .personalTime)) ?? [])
            .compactMap(\.value)
    }
}

struct ScheduleEnvelope: Decodable { let schedule: Schedule }

public struct BulkFailure: Codable, Equatable, Sendable {
    public var sessionId: String
    /// A stable value such as "scheduleConflict". Unknown values are a generic refusal.
    public var code: String
    public var conflictsWith: [String]?

    public init(sessionId: String, code: String, conflictsWith: [String]? = nil) {
        self.sessionId = sessionId
        self.code = code
        self.conflictsWith = conflictsWith
    }
}

/// The outcome of reserving or favoriting: reported per session, even on success.
public struct BulkResult: Codable, Equatable, Sendable {
    public var successful: [String]
    public var failed: [BulkFailure]

    public init(successful: [String] = [], failed: [BulkFailure] = []) {
        self.successful = successful
        self.failed = failed
    }
}

struct BulkEnvelope: Decodable { let result: BulkResult }

/// The whole catalog, as walked page by page.
public struct Catalog: Equatable, Sendable {
    public var sessions: [Session]
    /// Records dropped because they had no usable id or title.
    public var skipped: Int

    public init(sessions: [Session], skipped: Int = 0) {
        self.sessions = sessions
        self.skipped = skipped
    }
}
