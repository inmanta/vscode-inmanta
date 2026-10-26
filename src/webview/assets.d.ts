declare module "*.css" {
    const content: string;
    export default content;
}

declare module "*.woff2" {
    const dataUrl: string;
    export default dataUrl;
}

/** react-icons/fa with the React rendering swapped for the svg tree, see iconShim.js */
declare module "fa-icon-trees" {
    interface Tree {
        tag: string;
        attr: Record<string, string>;
        child: Tree[];
    }
    const icons: { [name: string]: (() => Tree) | undefined };
    export = icons;
}
