import SwiftUI

// MARK: - Liquid Glass Compatibility Shim
// Backports the iOS 26 / watchOS 26 Liquid Glass modifiers to Xcode 16 / iOS 17+ / watchOS 10+
// using SwiftUI Material and Shape overlays.

public struct GlassStyle: Sendable {
    public static let regular = GlassStyle()
    public static let clear = GlassStyle()

    public var tintColor: Color? = nil

    public init(tintColor: Color? = nil) {
        self.tintColor = tintColor
    }

    public func interactive() -> GlassStyle { self }

    public func tint(_ color: Color) -> GlassStyle {
        var copy = self
        copy.tintColor = color
        return copy
    }

    public func tint(_ color: Color?) -> GlassStyle {
        var copy = self
        copy.tintColor = color
        return copy
    }
}

public struct GlassButtonStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial, in: Capsule())
            .opacity(configuration.isPressed ? 0.7 : 1.0)
    }
}

public extension ButtonStyle where Self == GlassButtonStyle {
    static var glass: GlassButtonStyle { GlassButtonStyle() }
    static var glassProminent: GlassButtonStyle { GlassButtonStyle() }
}

public extension View {
    @ViewBuilder
    func glassEffect<S: Shape>(_ style: GlassStyle = .regular, in shape: S) -> some View {
        self.background {
            shape.fill(.ultraThinMaterial)
                .overlay {
                    if let tint = style.tintColor {
                        shape.fill(tint)
                    }
                }
        }
    }

    @ViewBuilder
    func glassEffect(_ style: GlassStyle = .regular) -> some View {
        self.background {
            Rectangle().fill(.ultraThinMaterial)
                .overlay {
                    if let tint = style.tintColor {
                        Rectangle().fill(tint)
                    }
                }
        }
    }
}
