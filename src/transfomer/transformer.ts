import {
	Container,
	Point,
	FederatedPointerEvent,
	Rectangle,
	Matrix,
	Ticker,
	Graphics
} from 'pixi.js'

import {Wireframe} from './parts/wireframe.js'
import {type HandleKind, Handle, type Side} from './parts/handle'

const TMP = {
	delta: new Matrix(),
	newLocal: new Matrix()
}

const isSide = (h: string): h is Side => h.startsWith('m')

export class Transformer extends Container {
	group: Container[]
	wireframe = new Wireframe()
	isDragging = false
	lastPointer = new Point()
	activeHandle: HandleKind | null = null

	#handles: Record<string, Handle>
	#childStart = new Map<Container, Matrix>()
	#pivotWorld = new Point()
	#angle = 0
	#startAngle = 0

	#opBounds = new Rectangle()
	#scalePivotLocal = new Point()

	#unclippedLocal = new Rectangle()    // scaled-but-not-cropped max
	#unclippedAtOp = new Rectangle()     // snapshot at op begin
	#clippedLocal = new Rectangle()      // current crop

	#maskG = new Graphics()
	#minClipW = 1
	#minClipH = 1

	opts: {group: Container[], centeredScaling?: boolean}

	constructor(opts: {group: Container[], centeredScaling?: boolean}) {
		super()
		this.opts = opts
		this.group = opts.group
		this.eventMode = 'static'

		const cb = {
			beginDrag: (h: HandleKind, s: Point) => this.#beginHandleDrag(h, s),
			updateDrag: (h: HandleKind, p: Point) => this.#updateDrag(h, p),
			endDrag: () => this.#endDrag()
		}

		this.#handles = {
			tl: new Handle('tl', 'nwse-resize', cb),
			tr: new Handle('tr', 'nesw-resize', cb),
			bl: new Handle('bl', 'nesw-resize', cb),
			br: new Handle('br', 'nwse-resize', cb),
			ml: new Handle('ml', 'ew-resize', cb),
			mr: new Handle('mr', 'ew-resize', cb),
			mt: new Handle('mt', 'ns-resize', cb),
			mb: new Handle('mb', 'ns-resize', cb),
			rot: new Handle('rot', 'crosshair', {
				beginDrag: (_c, s) => this.#beginRotateDrag(s),
				updateDrag: (_c, p) => this.#rotate(p),
				endDrag: () => this.#endDrag()
			})
		}

		this.addChild(this.wireframe, this.#maskG, ...Object.values(this.#handles))
		this.#bindEvents()
		Ticker.shared.addOnce(() => this.#initBounds())
	}

	#bindEvents() {
		this.on('pointerdown', this.#onDown)
		this.on('pointerup', this.#onUp)
		this.on('pointerupoutside', this.#onUp)
		this.on('globalpointermove', this.#onMove)
	}

	#initBounds() {
		const ob = this.#computeWorldAABB()
		this.#pivotWorld.set(ob.x + ob.width / 2, ob.y + ob.height / 2)

		const local = new Rectangle(-ob.width / 2, -ob.height / 2, ob.width, ob.height)
		this.#unclippedLocal.copyFrom(local)
		this.#clippedLocal.copyFrom(local)

		this.#refresh()
	}

	#onDown = (e: FederatedPointerEvent) => {
		this.isDragging = true
		this.lastPointer.copyFrom(e.global)
		this.cursor = 'grabbing'
	}

	#onUp = () => {
		this.isDragging = false
		this.activeHandle = null
		this.cursor = 'default'
	}

	#onMove = (e: FederatedPointerEvent) => {
		if (!this.isDragging || this.activeHandle || !this.parent) return

		const from = this.parent.toLocal(this.lastPointer)
		const to = this.parent.toLocal(e.global)
		const dx = to.x - from.x
		const dy = to.y - from.y

		for (const obj of this.group) {
			obj.x += dx
			obj.y += dy
		}

		this.#pivotWorld.x += dx
		this.#pivotWorld.y += dy

		this.lastPointer.copyFrom(e.global)
		this.#refresh()
	}

	#beginHandleDrag(handle: HandleKind, _start: Point) {
		this.isDragging = true
		this.activeHandle = handle
		this.#childStart.clear()

		for (const c of this.group)
			this.#childStart.set(c, c.localTransform.clone())

		this.rotation = this.#angle
		this.#opBounds.copyFrom(this.#clippedLocal)
		this.#unclippedAtOp.copyFrom(this.#unclippedLocal)

		if (!isSide(handle))
			this.#setScalePivot(handle)
	}

	#updateDrag(handle: HandleKind, pos: Point) {
		if (isSide(handle)) this.#clipEdge(handle, pos)
		else this.#scale(handle, pos)
	}

	#scale(handle: HandleKind, global: Point) {
		const pivotLocal = this.#scalePivotLocal
		const proposed = this.#proposeScaledRect(handle, this.toLocal(global), pivotLocal, this.#opBounds)

		const sx = proposed.width / this.#opBounds.width
		const sy = proposed.height / this.#opBounds.height
		const pivotWorld = this.toGlobal(pivotLocal)

		this.#applyWorldDelta(this.#deltaScale(pivotWorld, this.#angle, sx, sy))

		this.#unclippedLocal.copyFrom(this.#scaleRectAbout(this.#unclippedAtOp, pivotLocal, sx, sy))
		this.#setCrop(proposed)
	}

	#clipEdge(handle: Side, global: Point) {
		const p = this.toLocal(global)
		const s = this.#clippedLocal

		// mutate s in place
		if (handle === 'ml') {
			const right = s.x + s.width
			const newLeft = Math.min(p.x, right - this.#minClipW)
			s.width = right - newLeft
			s.x = newLeft
		} else if (handle === 'mr') {
			s.width = Math.max(this.#minClipW, p.x - s.x)
		} else if (handle === 'mt') {
			const bottom = s.y + s.height
			const newTop = Math.min(p.y, bottom - this.#minClipH)
			s.height = bottom - newTop
			s.y = newTop
		} else { // mb
			s.height = Math.max(this.#minClipH, p.y - s.y)
		}

		this.#clampRectToMax(s, this.#unclippedLocal)
		this.#refresh()
	}

	#beginRotateDrag(start: Point) {
		this.isDragging = true
		this.activeHandle = 'rot'
		this.#childStart.clear()
		for (const c of this.group)
			this.#childStart.set(c, c.localTransform.clone())
		this.#startAngle = Math.atan2(start.y - this.#pivotWorld.y, start.x - this.#pivotWorld.x)
	}

	#rotate(global: Point) {
		const now = Math.atan2(global.y - this.#pivotWorld.y, global.x - this.#pivotWorld.x)
		const da = now - this.#startAngle
		const live = this.#angle + da
		this.#applyWorldDelta(this.#deltaRotate(this.#pivotWorld, da))
		this.rotation = live
		this.#refresh(live)
	}

	#endDrag() {
		this.isDragging = false
		this.#angle = this.rotation
		this.activeHandle = null
		this.#refresh(this.#angle)
	}

	#computeWorldAABB() {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
		for (const obj of this.group) {
			const b = obj.getBounds()
			minX = Math.min(minX, b.x)
			minY = Math.min(minY, b.y)
			maxX = Math.max(maxX, b.x + b.width)
			maxY = Math.max(maxY, b.y + b.height)
		}
		return new Rectangle(minX, minY, maxX - minX, maxY - minY)
	}

	#refresh(angle: number = this.#angle) {
		if (this.parent) this.position.copyFrom(this.parent.toLocal(this.#pivotWorld))
		this.rotation = angle

		const r = this.#clippedLocal
		this.wireframe.draw(r)

		const cx = r.x + r.width / 2
		const cy = r.y + r.height / 2

		this.#handles.tl.position.set(r.x, r.y)
		this.#handles.tr.position.set(r.x + r.width, r.y)
		this.#handles.bl.position.set(r.x, r.y + r.height)
		this.#handles.br.position.set(r.x + r.width, r.y + r.height)

		this.#handles.ml.position.set(r.x, cy)
		this.#handles.mr.position.set(r.x + r.width, cy)
		this.#handles.mt.position.set(cx, r.y)
		this.#handles.mb.position.set(cx, r.y + r.height)
		this.#handles.rot.position.set(cx, r.y - 30)

		this.#maskG.clear()
		this.#maskG.beginFill(0xffffff)
		this.#maskG.drawRect(r.x, r.y, r.width, r.height)
		this.#maskG.endFill()

		for (const o of this.group)
			o.mask = this.#maskG
	}

	// helpers

	#setScalePivot(handle: HandleKind) {
		const s = this.#opBounds
		if (this.opts.centeredScaling) {
			this.#scalePivotLocal.set(s.x + s.width / 2, s.y + s.height / 2)
			return
		}
		if (handle === 'tl') this.#scalePivotLocal.set(s.x + s.width, s.y + s.height)
		else if (handle === 'tr') this.#scalePivotLocal.set(s.x, s.y + s.height)
		else if (handle === 'bl') this.#scalePivotLocal.set(s.x + s.width, s.y)
		else this.#scalePivotLocal.set(s.x, s.y)
	}

	#proposeScaledRect(handle: HandleKind, p: Point, pivot: Point, start: Rectangle) {
		if (this.opts.centeredScaling) {
			const w = Math.max(this.#minClipW, Math.abs(p.x - pivot.x) * 2)
			const h = Math.max(this.#minClipH, Math.abs(p.y - pivot.y) * 2)
			return new Rectangle(pivot.x - w / 2, pivot.y - h / 2, w, h)
		}
		if (handle === 'tl') {
			const left = Math.min(p.x, pivot.x - this.#minClipW)
			const top = Math.min(p.y, pivot.y - this.#minClipH)
			return new Rectangle(left, top, pivot.x - left, pivot.y - top)
		}
		if (handle === 'tr') {
			const right = Math.max(p.x, pivot.x + this.#minClipW)
			const top = Math.min(p.y, pivot.y - this.#minClipH)
			return new Rectangle(pivot.x, top, right - pivot.x, pivot.y - top)
		}
		if (handle === 'bl') {
			const left = Math.min(p.x, pivot.x - this.#minClipW)
			const bottom = Math.max(p.y, pivot.y + this.#minClipH)
			return new Rectangle(left, pivot.y, pivot.x - left, bottom - pivot.y)
		}
		const right = Math.max(p.x, pivot.x + this.#minClipW)
		const bottom = Math.max(p.y, pivot.y + this.#minClipH)
		return new Rectangle(pivot.x, pivot.y, right - pivot.x, bottom - pivot.y)
	}

	#scaleRectAbout(src: Rectangle, pivot: Point, sx: number, sy: number) {
		const left = pivot.x + (src.x - pivot.x) * sx
		const top = pivot.y + (src.y - pivot.y) * sy
		const right = pivot.x + (src.x + src.width - pivot.x) * sx
		const bottom = pivot.y + (src.y + src.height - pivot.y) * sy
		const x = Math.min(left, right)
		const y = Math.min(top, bottom)
		const w = Math.max(this.#minClipW, Math.abs(right - left))
		const h = Math.max(this.#minClipH, Math.abs(bottom - top))
		return new Rectangle(x, y, w, h)
	}

	#deltaScale(pivotWorld: Point, angle: number, sx: number, sy: number) {
		return TMP.delta.identity()
			.translate(-pivotWorld.x, -pivotWorld.y)
			.rotate(-angle)
			.scale(sx, sy)
			.rotate(angle)
			.translate(pivotWorld.x, pivotWorld.y)
	}

	#deltaRotate(pivotWorld: Point, da: number) {
		return TMP.delta.identity()
			.translate(-pivotWorld.x, -pivotWorld.y)
			.rotate(da)
			.translate(pivotWorld.x, pivotWorld.y)
	}

	#applyWorldDelta(worldDelta: Matrix) {
		for (const c of this.group) {
			const start = this.#childStart.get(c)
			const parent = c.parent
			if (!start || !parent) continue
			const parentInv = parent.worldTransform.clone().invert()
			const startWorld = start.clone().append(parent.worldTransform)
			const newWorld = worldDelta.clone().append(startWorld)
			const newLocal = parentInv.clone().append(newWorld)
			c.setFromMatrix(newLocal)
		}
	}

	#setCrop(r: Rectangle) {
		this.#clippedLocal.copyFrom(r)
		this.#clampRectToMax(this.#clippedLocal, this.#unclippedLocal)
		this.#refresh()
	}

	#clampRectToMax(s: Rectangle, max: Rectangle) {
		if (s.x < max.x) {
			const d = max.x - s.x
			s.x = max.x
			s.width = Math.max(this.#minClipW, s.width - d)
		}
		if (s.y < max.y) {
			const d = max.y - s.y
			s.y = max.y
			s.height = Math.max(this.#minClipH, s.height - d)
		}
		const maxRight = max.x + max.width
		if (s.x + s.width > maxRight) s.width = Math.max(this.#minClipW, maxRight - s.x)
		const maxBottom = max.y + max.height
		if (s.y + s.height > maxBottom) s.height = Math.max(this.#minClipH, maxBottom - s.y)
	}
}
