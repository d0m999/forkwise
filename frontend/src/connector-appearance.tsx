import { DEFAULT_CONNECTOR_STYLE, type ConnectorStyle } from '../../backend/src/mapping/connector-contracts';

export function ConnectorAppearance({ value = DEFAULT_CONNECTOR_STYLE, blocked, change }: {
  value: ConnectorStyle | undefined; blocked: boolean; change: (patch: Partial<ConnectorStyle>) => void;
}) {
  return <>
    {(['startMarker', 'endMarker'] as const).map(endpoint => <label key={endpoint}>
      {endpoint === 'startMarker' ? '起点标记' : '终点标记'}
      <select disabled={blocked} value={value[endpoint]} onChange={event => change({ [endpoint]: event.target.value as ConnectorStyle['startMarker'] })}>
        <option value="none">无标记</option><option value="open-arrow">开放箭头</option><option value="triangle">三角箭头</option>
        <option value="dot">圆点</option><option value="diamond">菱形</option>
      </select>
    </label>)}
    <label>线条颜色<input type="color" disabled={blocked} value={value.color} onChange={event => change({ color: event.target.value })} /></label>
    <label>线宽<select disabled={blocked} value={value.width} onChange={event => change({ width: Number(event.target.value) })}>
      {[...new Set([2, 4, 8, value.width])].sort((a, b) => a - b).map(width => <option key={width} value={width}>{width} px</option>)}
    </select></label>
    <label>线型<select disabled={blocked} value={value.dash} onChange={event => change({ dash: event.target.value as ConnectorStyle['dash'] })}>
      <option value="solid">实线</option><option value="dashed">虚线</option>
    </select></label>
  </>;
}
