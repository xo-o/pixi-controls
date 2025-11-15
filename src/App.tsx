import { Application, Graphics, Assets, Sprite } from "pixi.js"
import { Transformer } from "./transfomer/transformer.js"

function App() {
  const containerRef = (container: HTMLDivElement | null) => {
    if (!container) return

    const init = async () => {
      const app = new Application()
      const IMAGE_ASSET_URL =
        'https://ik.imagekit.io/m5f5k3axy/default-image.jpg?updatedAt=1718055813764'

      await app.init({
        autoDensity: true,
        backgroundColor: 0x18181b,
        width: 1024,
        height: 1024,
        antialias: true,
        view: document.createElement('canvas'),
      })
      container.appendChild(app.canvas)

      const a = app.stage.addChild(new Graphics())
      a.star(0, 0, 5, 100)
        .fill(0xfedbac)

    
       a.position.set(300, 300)

      const texture = await Assets.load(IMAGE_ASSET_URL)
      const image = app.stage.addChild(new Sprite(texture))
      image.anchor.set(0.5)
      image.scale.set(0.75)
      image.pivot.set(image.width / 2, image.height / 2)
      image.position.set(800, 700)

      app.stage.addChild(new Transformer({
        group: [image]
      }))
    }

    init()
  }

  return (
    <div ref={containerRef} style={{ width: '100vw', height: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', backgroundColor: '#09090b' }} />
  )
}

export default App
