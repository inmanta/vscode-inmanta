// Stands in for the react-icons library in the webview: an icon returns its svg tree instead of a React element
export function GenIcon(data) {
    return () => data;
}
