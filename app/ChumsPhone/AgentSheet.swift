import SwiftUI

/// An agent, opened (a card that slides up; drag it down to put it away): its name and what it's doing, what it runs
/// on and on which model, its voice, and its soul. A tap on the name, or on a part of the soul, edits it right there; Save writes it as
/// you typed it, and it applies from the agent's next order. Undo puts the last change back.
struct AgentSheet: View {
    let agent: AgentInfo
    let hub: HubClient
    @State private var card: SoulCard?
    @State private var runtime: String?
    @State private var switching = false
    @State private var voice: String?
    @State private var models: [String: ModelChoices]?
    @State private var modelsAnswered = false          // the hub answered (models still nil: it couldn't be reached)
    @State private var model: String?                  // the model picked here, once one is (until then, the hub's)
    @State private var modelPicked = false
    @State private var permissions: [String: PermissionChoices]?
    @State private var permission: String?             // the mode picked here, once one is (until then, the hub's)
    @State private var permissionPicked = false
    @State private var editing: Part?
    @State private var text = ""
    @State private var saving = false
    @State private var message: String?
    @FocusState private var focused: Bool
    @Namespace private var pill

    /// A part of a soul, as the hub keeps it.
    enum Part: String, CaseIterable, Identifiable {
        case name, owns, refers, voice, body
        var id: String { rawValue }
        var title: String {
            switch self {
            case .name: "Name"
            case .owns: "What it does"
            case .refers: "Hands off"
            case .voice: "How it talks"
            case .body: "Notes"
            }
        }
        var limit: Int { switch self { case .name: 24; case .owns, .refers: 180; case .voice: 90; case .body: 2500 } }
        /// What goes in it, when it's empty or being written.
        var hint: String {
            switch self {
            case .name: "Its name"
            case .owns: "Its job: what it takes care of, and where"
            case .refers: "What it gives to which other agent"
            case .voice: "How it answers you"
            case .body: "Anything else it should know"
            }
        }
        static let soul: [Part] = [.owns, .refers, .voice, .body]
    }

    private var live: AgentInfo { hub.state?.agents?.first { $0.id == agent.id } ?? agent }
    private var currentRuntime: String { runtime ?? live.runtime ?? "claude" }
    private var currentModel: String? { modelPicked ? model : live.model }
    /// The model it runs on, by name: its own, or what its runtime is set to use.
    private var modelName: String {
        guard let c = models?[currentRuntime] else { return modelsAnswered ? currentModel ?? " " : " " }   // asking: nothing
        if let m = currentModel { return c.models.first { $0.id == m }?.name ?? m }
        return c.default ?? "\(AgentChoices.runtimeName(currentRuntime))'s own"
    }
    private var currentPermission: String? { permissionPicked ? permission : live.permission }
    /// How it asks before acting, in words: its own mode, or what its runtime is set to.
    private var permissionName: String {
        guard let c = permissions?[currentRuntime] else { return modelsAnswered ? currentPermission ?? " " : " " }
        if let m = currentPermission { return c.modes.first { $0.id == m }?.name ?? m }
        return c.default ?? "\(AgentChoices.runtimeName(currentRuntime))'s own"
    }
    /// What this Mac can run (an older hub doesn't say: then both).
    private var installed: [String] { hub.state?.runtimes ?? ["claude", "codex"] }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        header.id(Part.name).padding(.bottom, 26)
                        label("Runs on")
                        runsOn.padding(.bottom, 14)
                        modelRow
                        permissionRow
                        voiceRow.padding(.bottom, 26)
                        label("Soul")
                        soul
                        if card?.canUndo == true && editing == nil {
                            Button { undo() } label: {
                                Label("Undo the last change", systemImage: "arrow.uturn.backward")
                                    .font(.subheadline.weight(.medium)).foregroundStyle(Ink.quiet)
                                    .frame(minHeight: M.target).contentShape(Rectangle())
                            }
                            .buttonStyle(Pressable())
                            .padding(.top, 8)
                        }
                        if let message {
                            Text(message).font(.footnote).foregroundStyle(Pal.amber).padding(.top, 8)
                        }
                        Text("Tap a part to change it.")
                            .font(.footnote).foregroundStyle(Ink.quiet).padding(.top, 10).padding(.leading, 2)
                    }
                    .padding(.horizontal, 20).padding(.top, 30).padding(.bottom, 30)
                    .animation(Move.settle, value: editing)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: focused) { _, on in
                    guard on, let p = editing else { return }
                    Task { try? await Task.sleep(for: .milliseconds(350)); withAnimation(Move.settle) { proxy.scrollTo(p, anchor: .center) } }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .cardSheet(character: agent.character)
        .task {
            let c = await hub.soul(agent.id)
            withAnimation(Move.fade) { card = c }
            if c == nil { message = "Couldn't get its soul from your Mac." }
        }
        .task {
            async let m = hub.models(), p = hub.permissions()
            let (ms, ps) = await (m, p)
            withAnimation(Move.fade) { models = ms; permissions = ps; modelsAnswered = true }
        }
    }

    private func label(_ s: String) -> some View {
        Text(s).font(.footnote.weight(.semibold)).foregroundStyle(Ink.quiet).padding(.leading, 2).padding(.bottom, 8)
    }

    // MARK: who it is

    /// Its face, its name (a tap edits it here), what it's doing.
    private var header: some View {
        HStack(alignment: .center, spacing: 16) {
            AgentFace(character: agent.character, size: 68)
            VStack(alignment: .leading, spacing: 4) {
                if editing == .name {
                    TextField(Part.name.hint, text: $text)
                        .font(.title.weight(.bold)).foregroundStyle(.white).tint(.white)
                        .focused($focused).submitLabel(.done).onSubmit { save(.name) }
                    Rectangle().fill(Color.white.opacity(0.3)).frame(height: 1)
                    editButtons(.name).padding(.top, 6)
                } else {
                    HStack(spacing: 10) {
                        Text(card?.name ?? live.name).font(.title.weight(.bold)).foregroundStyle(.white)
                        // a pen on glass: the name can be changed here
                        Image(systemName: "pencil").font(.footnote.weight(.semibold)).foregroundStyle(.white)
                            .frame(width: 30, height: 30)
                            .glassEffect(.regular, in: Circle())
                            .accessibilityHidden(true)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { if editing == nil { begin(.name) } }
                        .accessibilityHint("Renames \(live.name)")
                        .accessibilityIdentifier("part-name")
                    Text(AgentWords.state(live)).font(.subheadline.weight(.medium)).foregroundStyle(AgentWords.color(live))
                }
            }
            Spacer(minLength: 0)
        }
        .opacity(editing != nil && editing != .name ? 0.4 : 1)
    }

    /// Claude Code or Codex: the chosen one lit, sliding across.
    private var runsOn: some View {
        HStack(spacing: 4) {
            ForEach([("claude", "Claude Code"), ("codex", "Codex")], id: \.0) { id, title in
                let on = currentRuntime == id, can = installed.contains(id)
                Button {
                    guard can else { message = "\(title) isn't installed on your Mac."; Haptics.play(.failure); return }
                    switchTo(id)
                } label: {
                    HStack(spacing: 6) {
                        Text(title)
                        if switching && on { ProgressView().controlSize(.mini).tint(.black) }
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(on ? .black : can ? Color(white: 0.8) : Color(white: 0.35))
                    .frame(maxWidth: .infinity).frame(height: 40)
                    .background { if on { Capsule().fill(.white).matchedGeometryEffect(id: "pill", in: pill) } }
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Color.white.opacity(0.09), in: Capsule())
        .disabled(switching)
        .opacity(editing != nil ? 0.4 : 1)
        .animation(Move.snap, value: currentRuntime)
    }

    private var modelRow: some View {
        NavigationLink {
            AgentChoices(agent: live, title: "Model", tag: "model", runtime: currentRuntime,
                         items: models?[currentRuntime]?.models, defaultLabel: models?[currentRuntime]?.default, answered: modelsAnswered,
                         footer: "\(live.name) restarts on the model you pick. Its conversation carries on.",
                         restart: "Restart it on the new model",
                         picked: Binding(get: { currentModel }, set: { model = $0; modelPicked = true })) { await hub.setModel(agent.id, model: $0) }
                .cardPage()
        } label: {
            row("Model", value: modelName)
        }
        .buttonStyle(Pressable())
        .opacity(editing != nil || switching ? 0.4 : 1)
        .disabled(editing != nil || switching)
        .accessibilityIdentifier("model-row")
    }

    /// How it asks before acting (Asks first, Edits on its own, Decides on its own…): a page like Model's.
    private var permissionRow: some View {
        NavigationLink {
            AgentChoices(agent: live, title: "Permissions", tag: "permission", runtime: currentRuntime,
                         items: permissions?[currentRuntime]?.modes, defaultLabel: permissions?[currentRuntime]?.default, answered: modelsAnswered,
                         footer: "\(live.name) restarts with what you pick. Its conversation carries on.",
                         restart: "Restart it with the new permissions",
                         picked: Binding(get: { currentPermission }, set: { permission = $0; permissionPicked = true })) { await hub.setPermission(agent.id, mode: $0) }
                .cardPage()
        } label: {
            row("Permissions", value: permissionName)
        }
        .buttonStyle(Pressable())
        .opacity(editing != nil || switching ? 0.4 : 1)
        .disabled(editing != nil || switching)
        .accessibilityIdentifier("permission-row")
    }

    /// A row that opens a page: what it is, its value, a chevron.
    private func row(_ title: String, value: String) -> some View {
        HStack {
            Text(title).font(.body).foregroundStyle(.white)
            Spacer(minLength: 12)
            Text(value).font(.body).foregroundStyle(Ink.quiet).lineLimit(1)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Ink.ghost)
        }
        .frame(minHeight: M.target).contentShape(Rectangle())
    }

    private var voiceRow: some View {
        NavigationLink {
            AgentVoices(agent: live, hub: hub, picked: Binding(get: { voice ?? live.voice }, set: { voice = $0 }))
                .cardPage()
        } label: {
            row("Voice", value: (voice ?? live.voice).map(AgentVoices.label) ?? "The phone's own")
        }
        .buttonStyle(Pressable())
        .opacity(editing != nil ? 0.4 : 1)
        .disabled(editing != nil)
    }

    // MARK: the soul: one glass panel, a part per row

    private var soul: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(Part.soul.enumerated()), id: \.element) { i, p in
                if i > 0 { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5).padding(.leading, 16) }
                part(p).id(p)
            }
        }
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: M.tile, style: .continuous))
    }

    private func value(_ p: Part) -> String {
        switch p {
        case .name: card?.name ?? ""
        case .owns: card?.owns ?? ""
        case .refers: card?.refers ?? ""
        case .voice: card?.voice ?? ""
        case .body: card?.body ?? ""
        }
    }

    private func part(_ p: Part) -> some View {
        let on = editing == p, v = value(p)
        return VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(p.title).font(.footnote.weight(.semibold)).foregroundStyle(on ? .white : Ink.quiet)
                Spacer()
                if on {
                    Text("\(text.count) / \(p.limit)").font(.caption.weight(.medium)).monospacedDigit()
                        .foregroundStyle(text.count > p.limit ? Pal.red : Ink.ghost)
                }
            }
            if on {
                TextField(p.hint, text: $text, axis: .vertical)
                    .font(.body).foregroundStyle(.white).tint(.white)
                    .lineLimit(1...(p == .body ? 14 : 6))
                    .focused($focused)
                    .submitLabel(p == .body ? .return : .done)
                    .onSubmit { if p != .body { save(p) } }
                editButtons(p).padding(.top, 6)
            } else if card == nil {
                Text(" ").font(.body).accessibilityHidden(true)              // still coming from the Mac: blank, not the hint
            } else {
                Text(v.isEmpty ? p.hint : v).font(.body)
                    .foregroundStyle(v.isEmpty ? Ink.ghost : .white)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 13)
        .contentShape(Rectangle())
        .onTapGesture { if editing == nil && card != nil { begin(p) } }
        .opacity(editing != nil && !on ? 0.4 : 1)
        .accessibilityElement(children: on ? .contain : .combine)
        .accessibilityHint(on ? "" : "Edits \(p.title.lowercased())")
        .accessibilityIdentifier("part-\(p.rawValue)")
    }

    private func editButtons(_ p: Part) -> some View {
        HStack(spacing: 14) {
            Spacer()
            Button("Cancel") { stopEditing() }
                .font(.subheadline.weight(.medium)).foregroundStyle(Ink.quiet)
                .buttonStyle(Pressable())
            Button { save(p) } label: {
                Group { if saving { ProgressView().tint(.black) } else { Text("Save") } }
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.black)
                    .frame(minWidth: 60).frame(height: 34).padding(.horizontal, 6)
                    .background(Color.white, in: Capsule())
            }
            .buttonStyle(Pressable())
            .disabled(saving || text.count > p.limit || (p == .name && text.trimmingCharacters(in: .whitespaces).isEmpty))
        }
    }

    // MARK: doing it

    private func begin(_ p: Part) {
        Haptics.play(.click)
        text = value(p); message = nil
        withAnimation(Move.settle) { editing = p }
        Task { try? await Task.sleep(for: .milliseconds(60)); focused = true }
    }
    private func stopEditing() {
        focused = false
        withAnimation(Move.settle) { editing = nil }
    }
    private func save(_ p: Part) {
        guard !saving else { return }
        if text == value(p) { stopEditing(); return }
        saving = true
        Task {
            let (c, e) = await hub.setSoul(agent.id, field: p.rawValue, value: text)
            saving = false
            if let c { card = c; Haptics.play(.success); stopEditing() } else { message = e ?? "Couldn't save that."; Haptics.play(.failure) }
        }
    }
    private func switchTo(_ r: String) {
        guard r != currentRuntime, !switching else { return }
        switching = true; message = nil
        Haptics.play(.click)
        Task {
            if let e = await hub.setRuntime(agent.id, runtime: r) { message = e; Haptics.play(.failure) }
            else { runtime = r; modelPicked = false; permissionPicked = false; Haptics.play(.success) }   // each runtime keeps its own
            switching = false
        }
    }
    private func undo() {
        Task {
            let (c, e) = await hub.undoSoul(agent.id)
            if let c { card = c; Haptics.play(.success) } else { message = e }
        }
    }
}

/// One of an agent's settings picked from a list (its model, its permissions): its runtime's own setting first
/// (Default), then each choice with a line about it. A tap switches it: the agent restarts with it, and its
/// conversation carries on. While it works, it asks first.
struct AgentChoices: View {
    let agent: AgentInfo
    let title: String                                // the page's: "Model", "Permissions"
    let tag: String                                  // its rows' identifiers: "model-opus", "permission-default"
    let runtime: String
    let items: [ModelChoices.Model]?
    let defaultLabel: String?                        // what the runtime uses when the agent has none of its own
    let answered: Bool                               // the hub answered: no items now means it couldn't be reached
    let footer: String
    let restart: String                              // the button that restarts it while it works
    @Binding var picked: String?
    let apply: (String?) async -> String?            // nil once it's set, else why not
    @State private var busy: Choice?
    @State private var asking: Choice?
    @State private var error: String?

    /// A row: a choice, or none (the runtime's own setting).
    struct Choice: Identifiable, Equatable { let value: String?; var id: String { value ?? "" } }
    static func runtimeName(_ r: String) -> String { r == "codex" ? "Codex" : "Claude Code" }
    private var working: Bool { agent.status == "working" || agent.status == "compacting" }

    var body: some View {
        List {
            if let items {
                Section {
                    item(Choice(value: nil), "Default",
                         about: defaultLabel.map { "\(Self.runtimeName(runtime))'s setting: \($0)" } ?? "\(Self.runtimeName(runtime))'s own setting")
                    ForEach(items) { m in item(Choice(value: m.id), m.name, about: m.about) }
                } footer: {
                    Text(footer)
                }
                .cardRows()
            } else {
                Text(answered ? error ?? "Can't reach your Mac" : "Asking your Mac…").foregroundStyle(Ink.quiet)
                    .listRowBackground(Color.clear)
            }
            if let error, items != nil { Text(error).font(.footnote).foregroundStyle(Pal.amber).listRowBackground(Color.clear) }
        }
        .navigationTitle(title)
        .confirmationDialog("\(agent.name) is working", isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }),
                            titleVisibility: .visible, presenting: asking) { c in
            Button(restart) { set(c) }
        } message: { _ in
            Text("It restarts and stops what it's doing now.")
        }
    }

    private func item(_ c: Choice, _ name: String, about: String?) -> some View {
        Button {
            guard busy == nil, c.value != picked else { return }
            Haptics.play(.click)
            if working { asking = c } else { set(c) }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).foregroundStyle(.white)
                    if let about { Text(about).font(.footnote).foregroundStyle(Ink.quiet) }
                }
                Spacer(minLength: 12)
                if busy == c { ProgressView().tint(.white) }
                else if picked == c.value { Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(.white) }
            }
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(picked == c.value ? .isSelected : [])
        .accessibilityIdentifier("\(tag)-\(c.value ?? "own")")      // own: the runtime's setting (a mode can be "default")
    }

    private func set(_ c: Choice) {
        busy = c; error = nil
        Task {
            if let e = await apply(c.value) { error = e; Haptics.play(.failure) }
            else { picked = c.value; Haptics.play(.success) }
            busy = nil
        }
    }
}

extension View {
    /// The app's sliding card: the whole height, a handle to drag it down by (no Done), rounded, over a frosted ground
    /// made of the agent's own colours. Every card in the app (an agent, Settings, a picture) is this one.
    func cardSheet(character: String) -> some View {
        self
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            .presentationCornerRadius(34)
            .presentationBackground {
                ZStack {
                    Color.black
                    AgentFace(character: character, size: 460)
                        .blur(radius: 70).opacity(0.34).offset(y: -170)
                    Rectangle().fill(Color.black.opacity(0.18))
                }
                .ignoresSafeArea()
            }
            .preferredColorScheme(.dark)
    }

    /// A page a card opens (Model, Voice): its list on the card's frosted ground, its title at the top, and back as a
    /// plain chevron, with no plate (a swipe from the left edge goes back too).
    func cardPage() -> some View { modifier(CardPage()) }

    /// The rows of a card's page: one surface, the same on every page.
    func cardRows() -> some View { listRowBackground(Color.white.opacity(0.08)) }
}

private struct CardPage: ViewModifier {
    @Environment(\.dismiss) private var dismiss

    func body(content: Content) -> some View {
        content
            .scrollContentBackground(.hidden)
            .containerBackground(.clear, for: .navigation)
            .toolbar(.visible, for: .navigationBar)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold)).foregroundStyle(.white)
                            .frame(width: M.target, height: M.target).contentShape(Rectangle())
                    }
                    .buttonStyle(Pressable())
                    .accessibilityLabel("Back")
                    .accessibilityIdentifier("back")
                }
            }
            .background(EdgeSwipeBack())
    }
}

/// A hidden back button turns off the swipe from the left edge: while the page is up, this turns it back on (it goes
/// back whenever there's a page to go back to), and gives it back to the stack as the page goes.
private struct EdgeSwipeBack: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Hook { Hook() }
    func updateUIViewController(_ hook: Hook, context: Context) {}

    final class Hook: UIViewController, UIGestureRecognizerDelegate {
        private weak var stack: UIGestureRecognizerDelegate?

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard let g = navigationController?.interactivePopGestureRecognizer, g.delegate !== self else { return }
            stack = g.delegate; g.delegate = self
        }
        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            if let g = navigationController?.interactivePopGestureRecognizer, g.delegate === self { g.delegate = stack }
        }
        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool { (navigationController?.viewControllers.count ?? 0) > 1 }
    }
}
